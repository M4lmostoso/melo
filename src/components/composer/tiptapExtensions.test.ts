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
    // A genuine paste carries the 'paste' meta; the run keeps its own red.
    const { schema } = editor.state;
    const red = schema.marks.textStyle.create({ color: "#DC2626" });
    editor.view.dispatch(
      editor.state.tr.replaceWith(6, 6, schema.text("RED", [red])).setMeta("paste", true),
    );
    expect(editor.getHTML()).toContain("rgb(220, 38, 38)"); // #DC2626, serialized
    // Caret after the paste is sticky-blue again for the next typed text.
    expect(colorAtCaret()).toBe("#2563EB");
  });

  it("sticky wins over a color INHERITED from surrounding quoted text", () => {
    // The original quote is gray; typing inside it must come out sticky, not gray.
    editor = makeEditor('<p><span style="color: #666666">quoted</span></p>');
    sticky = "#2563EB";
    editor.commands.setTextSelection(4); // caret inside the gray "quoted"
    // Insert bare text that inherits the gray from its neighbours.
    const { schema } = editor.state;
    editor.view.dispatch(
      editor.state.tr.replaceWith(4, 4, schema.text("ANSWER", [schema.marks.textStyle.create({ color: "#666666" })])),
    );
    expect(editor.getHTML()).toContain("rgb(37, 99, 235)"); // the answer is sticky blue
    expect(editor.getText()).toBe("quoANSWERted");
  });
});

describe("QuoteEditor — realistic Outlook/IMAP quote", () => {
  // The full extension set QuoteEditor mounts, with a color driven per-test.
  let s: string | null = null;
  let e: Editor;
  afterEach(() => e?.destroy());

  function mount(content: string) {
    return new Editor({
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
        StickyColor.configure({ getColor: () => s }),
      ],
      content,
    });
  }

  // A quote shaped the way ThreadView.buildThreadQuote wraps IMAP body_html:
  // a gray wrapper div, Outlook table layout, span/font colors.
  const OUTLOOK_QUOTE =
    '<div style="border-left:2px solid #ccc;padding-left:12px;color:#666">' +
    "On Mon, Someone wrote:<br>" +
    '<table><tbody><tr><td><span style="color: #1F497D">Please answer below</span></td></tr>' +
    '<tr><td><font color="#1F497D">Question two?</font></td></tr></tbody></table>' +
    "</div>";

  it("preserves the quote structure and lets a typed answer be sticky-colored", () => {
    s = "#2563EB";
    e = mount(OUTLOOK_QUOTE);
    // Sanity: the quote parsed into a real table, text survived.
    expect(e.getHTML()).toContain("<td");
    expect(e.getText()).toContain("Please answer below");
    expect(e.getText()).toContain("Question two?");

    // Type an answer right after the Outlook-blue prompt, inheriting its blue.
    let after = -1;
    e.state.doc.descendants((node, pos) => {
      if (node.isText && node.text?.includes("below")) after = pos + (node.text?.length ?? 0);
    });
    expect(after).toBeGreaterThan(-1);
    e.view.dispatch(
      e.state.tr.replaceWith(
        after,
        after,
        e.state.schema.text(" MY ANSWER", [
          e.state.schema.marks.textStyle.create({ color: "#1F497D" }),
        ]),
      ),
    );
    const html = e.getHTML();
    expect(html).toContain("MY ANSWER");
    expect(html).toContain("rgb(37, 99, 235)"); // the answer is sticky blue, not Outlook blue
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

  it("recolors typed text INSIDE a table cell (Outlook/IMAP layout)", () => {
    // Outlook/Exchange emails are table-based; answering between rows types into
    // a cell whose text may inherit the mail's own color. Sticky must still win.
    let s: string | null = "#2563EB";
    const e = new Editor({
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
        StickyColor.configure({ getColor: () => s }),
      ],
      content:
        '<table><tbody><tr><td><span style="color: #1F497D">Q</span></td></tr></tbody></table>',
    });
    // Caret just after the Outlook-blue "Q" inside the cell.
    const posOfQ = e.state.doc.textContent.indexOf("Q");
    // Resolve an in-cell position and insert bare text inheriting the blue.
    let cellTextPos = -1;
    e.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "Q") cellTextPos = pos + 1; // after "Q"
    });
    expect(cellTextPos).toBeGreaterThan(-1);
    e.view.dispatch(
      e.state.tr.replaceWith(
        cellTextPos,
        cellTextPos,
        e.state.schema.text("A", [e.state.schema.marks.textStyle.create({ color: "#1F497D" })]),
      ),
    );
    expect(e.getHTML()).toContain("<td"); // table intact
    expect(e.getHTML()).toContain("rgb(37, 99, 235)"); // the "A" is sticky blue
    void posOfQ;
    e.destroy();
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

describe("StickyColor — recolors text that landed uncolored", () => {
  // Insert a text node carrying NO marks, the way autocorrect / double-space /
  // IME range replacements do — bypassing stored marks entirely.
  function insertBare(from: number, to: number, text: string) {
    const { schema, tr } = editor.state;
    editor.view.dispatch(tr.replaceWith(from, to, schema.text(text)));
  }

  it("recolors a bare (mark-less) insertion at the caret", () => {
    editor = makeEditor("<p>hello</p>");
    sticky = "#2563EB";
    editor.commands.setTextSelection(6);
    insertBare(6, 6, "X"); // no marks — bypasses storedMarks
    expect(editor.getHTML()).toContain("rgb(37, 99, 235)");
    expect(editor.getText()).toBe("helloX");
  });

  it("recolors a bare range REPLACEMENT (autocorrect rewriting a word)", () => {
    editor = makeEditor("<p>teh done</p>");
    sticky = "#DC2626";
    // Autocorrect swaps "teh" (1..4) for "the", inserting mark-less text.
    insertBare(1, 4, "the");
    const html = editor.getHTML();
    expect(html).toContain("rgb(220, 38, 38)"); // the replacement is sticky red
    expect(editor.getText()).toBe("the done");
  });

  it("preserves co-located fontSize when recoloring inserted text", () => {
    editor = makeEditor('<p><span style="font-size: 20px">big</span> x</p>');
    sticky = "#7C3AED";
    // Insert bare text INSIDE the sized span (between 'b' and 'ig').
    insertBare(2, 2, "Z");
    const html = editor.getHTML();
    expect(html).toContain("font-size: 20px");
    expect(html).toContain("rgb(124, 58, 237)"); // #7C3AED
  });

  it("does NOT recolor text restored by undo", () => {
    // Original quote text is plain/uncolored; deleting then undoing must bring it
    // back UNCOLORED, not sticky-colored.
    editor = makeEditor("<p>quoted line</p>");
    sticky = "#2563EB";
    editor.commands.setTextSelection({ from: 1, to: 7 }); // select "quoted"
    editor.commands.deleteSelection();
    expect(editor.getText()).toBe(" line");
    editor.commands.undo();
    expect(editor.getText()).toBe("quoted line");
    expect(editor.getHTML()).not.toContain("color:"); // still plain, not recolored
  });

  it("does NOT recolor pasted content that carries its own color", () => {
    editor = makeEditor("<p>hi </p>");
    sticky = "#2563EB";
    editor.commands.setTextSelection(4);
    // Real paste carries the 'paste' meta — must be left untouched.
    const { schema } = editor.state;
    const redMark = schema.marks.textStyle.create({ color: "#DC2626" });
    editor.view.dispatch(
      editor.state.tr
        .replaceWith(4, 4, schema.text("RED", [redMark]))
        .setMeta("paste", true),
    );
    expect(editor.getHTML()).toContain("rgb(220, 38, 38)");
    expect(editor.getHTML()).not.toContain("rgb(37, 99, 235)"); // sticky NOT forced onto paste
  });
});
