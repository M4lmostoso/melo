import { useEffect, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Image } from "@tiptap/extension-image";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import { Type } from "lucide-react";
import { BlockStyle, FontFamily, FontSize, StickyColor } from "./tiptapExtensions";
import { COLORS } from "./EditorToolbar";
import { t } from "@/i18n";

interface QuoteEditorProps {
  /** Initial quoted HTML to edit. Read once on mount. */
  initialHtml: string;
  /** Called with the edited HTML on every change. */
  onChange: (html: string) => void;
}

/**
 * Editable quoted-citation block. Mounted only while the user is editing the
 * quote (see the "Edit quote" toggle in Composer). Carries a "sticky color":
 * once the user picks a text color it stays active across lines/edits until they
 * change it — so inline answers can be typed in one color without re-selecting
 * it on every line (see {@link StickyColor}). No color is sticky until the user
 * picks one for the first time.
 */
export function QuoteEditor({ initialHtml, onChange }: QuoteEditorProps) {
  const [stickyColor, setStickyColor] = useState<string | null>(null);
  const stickyColorRef = useRef<string | null>(null);
  const [showColors, setShowColors] = useState(false);
  const colorPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    stickyColorRef.current = stickyColor;
  }, [stickyColor]);

  useEffect(() => {
    if (!showColors) return;
    const handler = (e: MouseEvent) => {
      if (colorPickerRef.current && !colorPickerRef.current.contains(e.target as Node)) {
        setShowColors(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showColors]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false },
      }),
      Image.configure({ inline: true, allowBase64: true }),
      TextStyle,
      Color,
      FontFamily,
      FontSize,
      BlockStyle,
      StickyColor.configure({ getColor: () => stickyColorRef.current }),
    ],
    content: initialHtml,
    onUpdate: ({ editor: ed }) => onChange(ed.getHTML()),
    editorProps: {
      attributes: {
        class:
          "prose prose-sm max-w-none px-4 py-2 min-h-[80px] focus:outline-none text-text-tertiary text-xs",
      },
    },
  });

  if (!editor) return null;

  const activeColor = stickyColor ?? editor.getAttributes("textStyle").color ?? null;

  const btn = (label: string, isActive: boolean, onClick: () => void, title: string) => (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`px-1.5 py-0.5 text-xs rounded hover:bg-bg-hover transition-colors ${
        isActive ? "bg-bg-hover text-accent font-semibold" : "text-text-secondary"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div>
      {/* Compact quote-editing toolbar */}
      <div className="flex items-center gap-0.5 px-3 py-1 border-b border-border-secondary bg-bg-secondary/60">
        {btn("B", editor.isActive("bold"), () => editor.chain().focus().toggleBold().run(), "Bold")}
        {btn("I", editor.isActive("italic"), () => editor.chain().focus().toggleItalic().run(), "Italic")}
        {btn("U", editor.isActive("underline"), () => editor.chain().focus().toggleUnderline().run(), "Underline")}

        {/* Sticky color picker */}
        <div ref={colorPickerRef} className="relative">
          <button
            type="button"
            title={t("composer.stickyColorTip")}
            onClick={() => setShowColors((v) => !v)}
            className={`p-1 rounded hover:bg-bg-hover transition-colors flex flex-col items-center gap-0.5 ${showColors ? "bg-bg-hover" : ""}`}
          >
            <Type size={12} className="text-text-secondary" />
            <span
              className="w-3.5 h-0.5 rounded-full"
              style={{ backgroundColor: activeColor ?? "transparent" }}
            />
          </button>

          {showColors && (
            <div className="absolute top-full left-0 mt-1 z-30 p-2.5 bg-bg-primary border border-border-primary rounded-lg shadow-2xl min-w-[172px]">
              <div className="grid grid-cols-8 gap-1 mb-2">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    title={c}
                    onClick={() => {
                      editor.chain().focus().setColor(c).run();
                      setStickyColor(c);
                      setShowColors(false);
                    }}
                    className="rounded border border-border-primary hover:scale-125 transition-transform"
                    style={{ backgroundColor: c, width: "18px", height: "18px" }}
                  />
                ))}
              </div>
              <button
                type="button"
                onClick={() => {
                  editor.chain().focus().unsetColor().run();
                  setStickyColor(null);
                  setShowColors(false);
                }}
                className="w-full text-[11px] text-text-tertiary hover:text-text-primary text-center py-0.5 border-t border-border-secondary pt-1.5"
              >
                {t("composer.removeColor")}
              </button>
            </div>
          )}
        </div>

        <span className="ml-1.5 text-[11px] text-text-tertiary truncate">
          {stickyColor ? t("composer.stickyColorOn") : t("composer.stickyColorHint")}
        </span>
      </div>

      <EditorContent editor={editor} />
    </div>
  );
}
