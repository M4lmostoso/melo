import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Transaction } from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";
import type { Mark, MarkType } from "@tiptap/pm/model";

/**
 * Preserves inline `style` attributes on block-level nodes (paragraph, heading, etc.).
 * TipTap's default schema strips unknown attributes; this extension re-adds `style`
 * so HTML signatures with per-paragraph font/color overrides round-trip correctly.
 */
export const BlockStyle = Extension.create({
  name: "blockStyle",

  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading", "bulletList", "orderedList", "listItem", "blockquote", "codeBlock"],
        attributes: {
          style: {
            default: null,
            parseHTML: (element: HTMLElement) => element.getAttribute("style") || null,
            renderHTML: (attributes: Record<string, unknown>) => {
              if (!attributes.style) return {};
              return { style: attributes.style as string };
            },
          },
        },
      },
    ];
  },
});

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    fontFamily: {
      setFontFamily: (fontFamily: string) => ReturnType;
      unsetFontFamily: () => ReturnType;
    };
    fontSize: {
      setFontSize: (fontSize: string) => ReturnType;
      unsetFontSize: () => ReturnType;
    };
  }
}

export const FontFamily = Extension.create({
  name: "fontFamily",

  addOptions() {
    return { types: ["textStyle"] };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          fontFamily: {
            default: null,
            parseHTML: (element: HTMLElement) =>
              element.style.fontFamily?.replace(/['"]/g, "") ?? null,
            renderHTML: (attributes: Record<string, unknown>) => {
              if (!attributes.fontFamily) {
                return {};
              }
              return {
                style: `font-family: ${attributes.fontFamily}`,
              };
            },
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setFontFamily:
        (fontFamily: string) =>
        ({ chain }) =>
          chain().setMark("textStyle", { fontFamily }).run(),
      unsetFontFamily:
        () =>
        ({ chain }) =>
          chain().unsetMark("textStyle").run(),
    };
  },
});

export const FontSize = Extension.create({
  name: "fontSize",

  addOptions() {
    return { types: ["textStyle"] };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element: HTMLElement) =>
              element.style.fontSize || null,
            renderHTML: (attributes: Record<string, unknown>) => {
              if (!attributes.fontSize) {
                return {};
              }
              return {
                style: `font-size: ${attributes.fontSize}`,
              };
            },
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setFontSize:
        (fontSize: string) =>
        ({ chain }) =>
          chain().setMark("textStyle", { fontSize }).run(),
      unsetFontSize:
        () =>
        ({ chain }) =>
          chain().unsetMark("textStyle").run(),
    };
  },
});

const STICKY_APPLIED_META = "stickyColorApplied";

/**
 * True for transactions the sticky-color plugin must NOT recolor: paste/drop/cut
 * (that content keeps its own color), undo/redo (they restore prior content —
 * recoloring it would corrupt history), and our own applied transactions (loop
 * guard). Undo/redo are tagged by prosemirror-history's `history$` meta.
 */
function isUserInput(tr: Transaction): boolean {
  return (
    tr.docChanged &&
    !tr.getMeta("paste") &&
    tr.getMeta("uiEvent") !== "paste" &&
    tr.getMeta("uiEvent") !== "drop" &&
    tr.getMeta("uiEvent") !== "cut" &&
    !tr.getMeta("history$") &&
    !tr.getMeta(STICKY_APPLIED_META)
  );
}

/**
 * Collects the ranges inserted by the given transactions, expressed in the
 * coordinates of the final document, so the plugin can recolor freshly typed
 * text. Only ranges from {@link isUserInput} transactions are returned.
 */
function collectInsertedRanges(
  transactions: readonly Transaction[],
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  transactions.forEach((tr, ti) => {
    if (!isUserInput(tr)) return;
    tr.mapping.maps.forEach((stepMap, si) => {
      stepMap.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
        if (newEnd <= newStart) return; // pure deletion, nothing inserted
        // Map the just-inserted range forward to the final doc: first through
        // the remaining steps of this transaction, then through every later one.
        const rest = new Mapping(tr.mapping.maps.slice(si + 1));
        let from = rest.map(newStart, -1);
        let to = rest.map(newEnd, 1);
        for (let tj = ti + 1; tj < transactions.length; tj++) {
          const later = transactions[tj];
          if (!later) continue;
          from = later.mapping.map(from, -1);
          to = later.mapping.map(to, 1);
        }
        if (to > from) ranges.push([from, to]);
      });
    });
  });
  return ranges;
}

/**
 * Keeps a chosen text color "sticky" while editing: once the user picks a color,
 * everything they type next — across new lines, cursor moves, and even edits the
 * browser makes on their behalf — inherits that color, until they pick a
 * different one or clear it. No re-selecting the color on each line.
 *
 * Two mechanisms, because seeding stored marks alone is not enough:
 *  1. Stored marks are re-seeded on the empty caret, so the very next typed
 *     character (and the caret indicator) carry the color.
 *  2. Any newly inserted, *uncolored* text is recolored after the fact. This is
 *     what makes it reliable: range replacements the browser performs —
 *     autocorrect, double-space→". ", IME composition — bypass stored marks and
 *     would otherwise land in the default color, which reads as "a word I just
 *     typed suddenly went black". Text that already carries a color (pasted
 *     runs, the original quote's own styling) is never touched.
 *
 * Skips paste/drop/undo/redo (see {@link isUserInput}); its own recolor
 * transactions carry a meta flag and `addToHistory:false`, so they neither loop
 * nor add extra undo steps. The active color is read lazily via `getColor`.
 */
export const StickyColor = Extension.create<{ getColor: () => string | null }>({
  name: "stickyColor",

  addOptions() {
    return { getColor: () => null };
  },

  addProseMirrorPlugins() {
    const getColor = this.options.getColor;
    return [
      new Plugin({
        key: new PluginKey("stickyColor"),
        appendTransaction(transactions, _oldState, newState) {
          const color = getColor();
          if (!color) return null;

          const markType: MarkType | undefined = newState.schema.marks.textStyle;
          if (!markType) return null;

          let tr = newState.tr;
          let changed = false;

          // (2) Recolor freshly inserted, uncolored text.
          for (const [from, to] of collectInsertedRanges(transactions)) {
            const start = Math.max(0, from);
            const end = Math.min(newState.doc.content.size, to);
            if (end <= start) continue;
            newState.doc.nodesBetween(start, end, (node, pos) => {
              if (!node.isText || !node.text) return;
              // Already the sticky color → skip (also converges the loop). Any
              // OTHER color here was inherited from surrounding text as the user
              // typed (e.g. the quote's own gray) — sticky must win over that.
              // Genuinely pasted runs never reach here: their transaction carries
              // the `paste` meta and is excluded by isUserInput.
              if (node.marks.some((m) => m.type === markType && m.attrs.color === color)) {
                return;
              }
              const nodeFrom = Math.max(start, pos);
              const nodeTo = Math.min(end, pos + node.nodeSize);
              if (nodeTo <= nodeFrom) return;
              const existing = node.marks.find((m) => m.type === markType);
              tr = tr.addMark(
                nodeFrom,
                nodeTo,
                markType.create({ ...(existing?.attrs ?? {}), color }),
              );
              changed = true;
            });
          }

          // (3) Seed stored marks so the next typed character is already colored.
          if (newState.selection.empty) {
            const currentMarks: readonly Mark[] =
              newState.storedMarks ?? newState.selection.$from.marks();
            const hasColor = currentMarks.some(
              (m) => m.type === markType && m.attrs.color === color,
            );
            if (!hasColor) {
              const existing = currentMarks.find((m) => m.type === markType);
              const nextMark = markType.create({ ...(existing?.attrs ?? {}), color });
              tr = tr.setStoredMarks([
                ...currentMarks.filter((m) => m.type !== markType),
                nextMark,
              ]);
              changed = true;
            }
          }

          if (!changed) return null;
          // Flag as our own (loop guard) and keep it out of the undo stack.
          tr.setMeta(STICKY_APPLIED_META, true);
          tr.setMeta("addToHistory", false);
          return tr;
        },
      }),
    ];
  },
});
