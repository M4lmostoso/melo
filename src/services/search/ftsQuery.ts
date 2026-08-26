/**
 * Safe FTS5 MATCH expression building.
 *
 * The user's raw text must never reach `MATCH` directly. FTS5 parses whatever
 * it is given as a *query expression*, so perfectly ordinary searches raise a
 * syntax error that the UI can only report as "no results":
 *
 *   mario@x.it   → fts5: syntax error near "@"
 *   report.pdf   → fts5: syntax error near "."
 *   e-mail       → no such column: mail
 *   costo: 50    → no such column: costo
 *   50%          → fts5: syntax error near "%"
 *   d'accordo    → fts5: syntax error near "'"
 *
 * Wrapping each token in double quotes turns it into a literal string that is
 * handed to the tokenizer instead of the query parser. With the `trigram`
 * tokenizer that is exactly a case-insensitive substring match, punctuation
 * included — so `"mario@x.it"` and `"report.pdf"` match the way a user expects.
 *
 * The equivalent Rust-side helper lives in `src-tauri/src/vector_search.rs`
 * (`build_fts_query`); it strips punctuation rather than quoting it, which is
 * acceptable there because that arm only feeds the hybrid retrieval ranking.
 */

/**
 * The trigram tokenizer indexes 3-character windows, so a term shorter than
 * this can never produce a match — including it in an AND expression silently
 * zeroes the whole query.
 */
export const FTS_MIN_TERM_LENGTH = 3;

/** Punctuation trimmed from the edges of a bare term ("rossi." → "rossi"). */
const EDGE_PUNCTUATION = /^[\s"'`.,;:!?()[\]{}<>«»…]+|[\s"'`.,;:!?()[\]{}<>«»…]+$/g;

/**
 * How multiple terms combine.
 *  - "all": every term must appear (Gmail semantics; what the search bar uses)
 *  - "any": at least one term must appear — higher recall, used by the AI
 *    question path where the extracted keywords are a guess, not a demand.
 */
export type FtsMatchMode = "all" | "any";

export interface FtsQuery {
  /** The MATCH expression, or "" when no usable term survived. */
  match: string;
  /** Positive terms, for result highlighting. */
  terms: string[];
  /** Terms dropped for being shorter than the trigram window. */
  droppedShortTerms: string[];
  /**
   * True when the input held only terms too short to match. The caller should
   * fall back to a LIKE query rather than reporting "no results".
   */
  tooShort: boolean;
}

/**
 * Split raw input into terms, honouring "quoted phrases" and a leading `-`
 * for negation. Returns terms with their edge punctuation trimmed; a quoted
 * phrase keeps its interior verbatim.
 */
function splitTerms(input: string): Array<{ text: string; negated: boolean }> {
  const out: Array<{ text: string; negated: boolean }> = [];
  // A quoted phrase, or a run of non-space characters.
  const re = /(-?)"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(input)) !== null) {
    if (m[2] !== undefined) {
      const text = m[2].trim();
      if (text) out.push({ text, negated: m[1] === "-" });
      continue;
    }
    let raw = m[3]!;
    const negated = raw.startsWith("-") && raw.length > 1;
    if (negated) raw = raw.slice(1);
    const text = raw.replace(EDGE_PUNCTUATION, "");
    if (text) out.push({ text, negated });
  }

  return out;
}

/** Quote a term as an FTS5 string literal, doubling any embedded quote. */
function quote(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/**
 * Turn raw user input into a MATCH expression that FTS5 can always parse.
 *
 * Positive terms are combined per `mode` (AND by default: every word must
 * appear, matching Gmail); `-term` becomes an FTS5 NOT clause. Terms shorter
 * than the trigram window are dropped rather than allowed to zero the result
 * set — when *every* term is too short the query is reported as `tooShort` so
 * the caller can fall back to a LIKE search on subject/sender.
 */
export function buildFtsQuery(
  input: string,
  mode: FtsMatchMode = "all",
): FtsQuery {
  const split = splitTerms(input ?? "");

  const terms: string[] = [];
  const negated: string[] = [];
  const droppedShortTerms: string[] = [];

  for (const { text, negated: isNegated } of split) {
    if (text.length < FTS_MIN_TERM_LENGTH) {
      droppedShortTerms.push(text);
      continue;
    }
    (isNegated ? negated : terms).push(text);
  }

  if (terms.length === 0) {
    return {
      match: "",
      terms: [],
      droppedShortTerms,
      // Only a "too short" situation if something was actually typed and the
      // sole reason nothing survived is term length.
      tooShort: droppedShortTerms.length > 0 && negated.length === 0,
    };
  }

  let match = terms.map(quote).join(mode === "any" ? " OR " : " AND ");
  if (negated.length > 0) {
    // An OR list has to be parenthesised before NOT applies to the whole of it.
    const positive = mode === "any" && terms.length > 1 ? `(${match})` : match;
    match = `${positive} NOT (${negated.map(quote).join(" OR ")})`;
  }

  return { match, terms, droppedShortTerms, tooShort: false };
}

/**
 * The positive terms of a query, for highlighting matches in the result list.
 * Operator segments (`from:x`, `is:unread`, …) are stripped first so their
 * values don't light up the subject line.
 */
export function highlightTermsFor(query: string): string[] {
  const withoutOperators = query.replace(
    /(?:^|\s)(?:from|to|subject|has|is|before|after|label|in):\s*(?:"[^"]*"|\S*)/gi,
    " ",
  );
  return buildFtsQuery(withoutOperators).terms;
}
