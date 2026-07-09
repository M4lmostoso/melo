import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Mark } from "@tiptap/pm/model";

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

/**
 * Keeps a chosen text color "sticky" while editing: once the user picks a color,
 * every newly typed character (across new lines and cursor moves) inherits that
 * color until they pick a different one or clear it — without re-selecting the
 * color on each line.
 *
 * Implemented by re-seeding the `textStyle` stored mark whenever the selection is
 * an empty caret. It only affects text typed next; existing text is never
 * recolored. The active color is read lazily via `getColor` so a React ref can
 * drive it. Returning `null` once the stored marks already carry the color makes
 * the appended transaction converge (no loop).
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
        appendTransaction(_transactions, _oldState, newState) {
          const color = getColor();
          if (!color) return null;

          const { selection } = newState;
          if (!selection.empty) return null;

          const markType = newState.schema.marks.textStyle;
          if (!markType) return null;

          const currentMarks: readonly Mark[] =
            newState.storedMarks ?? selection.$from.marks();

          // Already carrying the sticky color → nothing to do (converges the loop).
          if (
            currentMarks.some(
              (m) => m.type === markType && m.attrs.color === color,
            )
          ) {
            return null;
          }

          // Preserve any co-located textStyle attrs (fontFamily/fontSize).
          const existing = currentMarks.find((m) => m.type === markType);
          const nextMark = markType.create({ ...(existing?.attrs ?? {}), color });
          const nextMarks = [
            ...currentMarks.filter((m) => m.type !== markType),
            nextMark,
          ];
          return newState.tr.setStoredMarks(nextMarks);
        },
      }),
    ];
  },
});
