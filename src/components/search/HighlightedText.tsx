import { memo, useMemo } from "react";

interface HighlightedTextProps {
  text: string;
  /** Terms to highlight. Matched case-insensitively as substrings. */
  terms: string[];
}

/** Escape a term for literal use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Renders `text` with every occurrence of `terms` wrapped in a <mark>.
 *
 * Matching mirrors what the FTS trigram tokenizer does — a case- and
 * accent-insensitive substring — so what lights up is what actually matched.
 * Falls back to plain text when there is nothing to highlight.
 */
export const HighlightedText = memo(function HighlightedText({
  text,
  terms,
}: HighlightedTextProps) {
  const segments = useMemo(() => {
    if (!text || terms.length === 0) return null;

    const fold = (v: string) => v.normalize("NFD").replace(/\p{Diacritic}/gu, "");

    // Longest first, so "fattura" wins over "fat" on an overlapping match.
    const ordered = [...new Set(terms.map(fold))]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    if (ordered.length === 0) return null;
    const pattern = new RegExp(`(${ordered.map(escapeRegExp).join("|")})`, "giu");

    // The original text is what gets rendered, so the folded haystack must stay
    // index-aligned with it. Stripping the combining marks off precomposed
    // characters preserves the length; text that was already decomposed does
    // not, and falls back to accent-sensitive matching.
    const folded = fold(text);
    const haystack = folded.length === text.length ? folded : text;

    const out: Array<{ text: string; match: boolean }> = [];
    let last = 0;
    for (const m of haystack.matchAll(pattern)) {
      const start = m.index!;
      const end = start + m[0].length;
      if (start > last) out.push({ text: text.slice(last, start), match: false });
      out.push({ text: text.slice(start, end), match: true });
      last = end;
    }
    if (last === 0) return null;
    if (last < text.length) out.push({ text: text.slice(last), match: false });
    return out;
  }, [text, terms]);

  if (!segments) return <>{text}</>;

  return (
    <>
      {segments.map((seg, i) =>
        seg.match ? (
          <mark
            key={i}
            className="bg-accent/25 text-inherit rounded-[0.125rem] px-px"
          >
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
});
