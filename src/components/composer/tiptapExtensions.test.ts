import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import type { Mark } from "@tiptap/pm/model";
import { FontSize, StickyColor } from "./tiptapExtensions";

// A live text color the plugin should keep sticky. Mutated per-test to simulate
// the user picking / clearing a color.
let sticky: string | null = null;
let editor: Editor;

function makeEditor(content: string) {
  return new Editor({
    element: document.createElement("div"),
    extensions: [
      StarterKit.configure({ link: false }),
      TextStyle,
      Color,
      FontSize,
      StickyColor.configure({ getColor: () => sticky }),
    ],
    content,
  });
}

/** Effective marks that new typed input would receive at the caret. */
function marksAtCaret(): readonly Mark[] {
  const { state } = editor;
  return state.storedMarks ?? state.selection.$from.marks();
}

function colorAtCaret(): string | null {
  const ts = marksAtCaret().find((m) => m.type.name === "textStyle");
  return (ts?.attrs.color as string | undefined) ?? null;
}

beforeEach(() => {
  sticky = null;
});

afterEach(() => {
  editor?.destroy();
});

describe("StickyColor", () => {
  it("does nothing until a color is picked (no sticky by default)", () => {
    sticky = null;
    editor = makeEditor("<p>hello</p>");
    editor.commands.setTextSelection(3); // caret inside text, empty selection
    expect(colorAtCaret()).toBeNull();
    expect(editor.state.storedMarks).toBeNull();
  });

  it("seeds the stored textStyle color on an empty caret once a color is active", () => {
    editor = makeEditor("<p>hello</p>");
    sticky = "#2563EB";
    editor.commands.setTextSelection(3); // triggers appendTransaction
    // The guarantee: text typed next inherits the sticky color.
    expect(editor.state.storedMarks).not.toBeNull();
    expect(colorAtCaret()).toBe("#2563EB");
  });

  it("keeps the color across a new paragraph (Enter) without re-picking", () => {
    editor = makeEditor("<p>hello</p>");
    sticky = "#DC2626";
    editor.commands.setTextSelection(6); // end of "hello"
    editor.commands.splitBlock(); // simulate Enter
    expect(colorAtCaret()).toBe("#DC2626");
  });

  it("does NOT force the color when the selection is a non-empty range", () => {
    editor = makeEditor("<p>hello</p>");
    sticky = "#16A34A";
    editor.commands.setTextSelection({ from: 1, to: 4 }); // select "hel"
    // Plugin must skip ranged selections: typed replacement should inherit the
    // replaced text's marks, not be force-colored via storedMarks.
    expect(editor.state.storedMarks).toBeNull();
  });

  it("preserves co-located fontSize when seeding the sticky color", () => {
    // Caret sits inside text that already carries a custom font size.
    editor = makeEditor('<p><span style="font-size: 20px">big</span></p>');
    sticky = "#7C3AED";
    editor.commands.setTextSelection(3); // inside "big"
    const ts = marksAtCaret().find((m) => m.type.name === "textStyle");
    expect(ts?.attrs.color).toBe("#7C3AED");
    expect(ts?.attrs.fontSize).toBe("20px"); // size must survive the new mark
  });

  it("converges: repeated empty transactions do not loop or drift", () => {
    editor = makeEditor("<p>hi</p>");
    sticky = "#0284C7";
    editor.commands.setTextSelection(2);
    // If appendTransaction failed to converge, PM would recurse until it
    // throws / hangs. Dispatching several no-op transactions must stay stable.
    for (let i = 0; i < 6; i++) {
      editor.view.dispatch(editor.state.tr);
    }
    expect(colorAtCaret()).toBe("#0284C7");
  });

  it("stops being sticky when the color is cleared", () => {
    editor = makeEditor("<p>hello</p>");
    sticky = "#0284C7";
    editor.commands.setTextSelection(3);
    expect(colorAtCaret()).toBe("#0284C7");
    // User clears the color → getColor returns null → no more forcing.
    sticky = null;
    editor.commands.setTextSelection(2);
    expect(colorAtCaret()).toBeNull();
  });

  it("does not loop or corrupt marks across undo after sticky typing", () => {
    editor = makeEditor("<p>hello</p>");
    sticky = "#2563EB";
    editor.commands.setTextSelection(6);
    // Type a character carrying the sticky stored mark, the way the view does.
    editor.view.dispatch(
      editor.state.tr.replaceSelectionWith(
        editor.state.schema.text(
          "X",
          editor.state.storedMarks ?? undefined,
        ),
        false,
      ),
    );
    expect(editor.getHTML()).toContain("rgb(37, 99, 235)"); // #2563EB, serialized
    // Undo must complete (no masked infinite append loop) and drop the char.
    editor.commands.undo();
    expect(editor.getText()).toBe("hello");
  });

  it("pasted content keeps its own color; the caret after it stays sticky", () => {
    editor = makeEditor("<p>hello</p>");
    sticky = "#2563EB";
    editor.commands.setTextSelection(6);
    // Insert content that carries an explicit different color (like a paste).
    editor.commands.insertContent('<span style="color: #DC2626">RED</span>');
    // The inserted run kept its own red; the plugin never rewrote it.
    expect(editor.getHTML()).toContain("rgb(220, 38, 38)"); // #DC2626, serialized
    // Caret after the paste is sticky-blue again for the next typed text.
    expect(colorAtCaret()).toBe("#2563EB");
  });
});

describe("QuoteEditor schema — table fidelity", () => {
  let ed: Editor;
  afterEach(() => ed?.destroy());

  it("round-trips a table instead of collapsing it into paragraphs", () => {
    // Mirrors the extension set QuoteEditor mounts for quoted content.
    ed = new Editor({
      element: document.createElement("div"),
      extensions: [
        StarterKit.configure({ link: false }),
        TextStyle,
        Color,
        FontSize,
        Table.configure({ resizable: false }),
        TableRow,
        TableHeader,
        TableCell,
      ],
      content:
        "<table><tbody><tr><td>Q1</td><td>Q2</td></tr><tr><td>A1</td><td>A2</td></tr></tbody></table>",
    });
    const html = ed.getHTML();
    expect(html).toContain("<table");
    expect(html).toContain("<tr");
    expect(html).toContain("Q1");
    expect(html).toContain("A2");
  });

  it("would flatten a table WITHOUT the table extensions (regression guard)", () => {
    // Documents exactly what we fixed: the plain StarterKit schema drops tables.
    ed = new Editor({
      element: document.createElement("div"),
      extensions: [StarterKit.configure({ link: false })],
      content: "<table><tbody><tr><td>cell</td></tr></tbody></table>",
    });
    expect(ed.getHTML()).not.toContain("<table");
    expect(ed.getText()).toContain("cell"); // text survives, structure does not
  });
});
