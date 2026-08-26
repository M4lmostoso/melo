import type { ParsedSearchQuery } from "./searchParser";
import { buildFtsQuery, type FtsMatchMode } from "./ftsQuery";

export interface BuiltQuery {
  sql: string;
  params: unknown[];
  /**
   * The FROM + WHERE fragment (and its params) behind `sql`, so callers that
   * need a different projection — a COUNT, for instance — can compose one
   * instead of rewriting the generated SQL with regexes.
   */
  fromSql: string;
  whereSql: string;
  whereParams: unknown[];
  /** True when the free text was all shorter than the trigram window. */
  tooShort: boolean;
}

export interface BuildSearchOptions {
  accountId?: string | string[];
  limit?: number;
  /**
   * Exclude threads that live only in TRASH/SPAM (and pure-draft threads).
   * Lifted automatically by `label:trash` / `in:trash` / `in:anywhere`.
   */
  excludeSystemLabels?: boolean;
  /**
   * "relevance" ranks by weighted BM25 with a recency/attention multiplier;
   * "date" is a straight reverse-chronological listing. Relevance silently
   * degrades to date when there is no free text to score.
   */
  sort?: "relevance" | "date";
  /**
   * Collapse to one row per thread, keeping each thread's best-scoring
   * message. Without this a LIMIT is spent on messages, so a single noisy
   * thread can crowd every other conversation out of the result window.
   */
  groupByThread?: boolean;
  /**
   * How free-text terms combine — "all" (default) demands every word, "any"
   * trades precision for recall. See FtsMatchMode.
   */
  matchMode?: FtsMatchMode;
}

// ---------------------------------------------------------------------------
// Relevance
// ---------------------------------------------------------------------------

/**
 * Column weights for bm25(), in the order the FTS table declares them:
 * subject, from_name, from_address, body_text, snippet.
 *
 * Unweighted BM25 (the default `rank`) scores a hit buried in the body of a
 * long newsletter the same as — often better than — an exact subject match,
 * because a long document repeats the term more often. The subject and the
 * sender are what people actually search by, so they dominate here.
 */
const BM25_WEIGHTS = "12.0, 6.0, 6.0, 1.0, 3.0";

const DAY_MS = 86_400_000;

/**
 * Relevance × recency × attention.
 *
 * bm25() returns a negative number (more negative = better match), so it is
 * negated into a positive "higher is better" scale before the multipliers are
 * applied. Buckets are used rather than exp() because SQLite only exposes the
 * math functions when compiled with SQLITE_ENABLE_MATH_FUNCTIONS.
 */
function scoreExpression(nowParam: string): string {
  return `(-bm25(messages_fts, ${BM25_WEIGHTS}))
      * (CASE
          WHEN m.date >= ${nowParam} - ${7 * DAY_MS}   THEN 1.60
          WHEN m.date >= ${nowParam} - ${30 * DAY_MS}  THEN 1.35
          WHEN m.date >= ${nowParam} - ${90 * DAY_MS}  THEN 1.15
          WHEN m.date >= ${nowParam} - ${365 * DAY_MS} THEN 1.00
          ELSE 0.85
        END)
      * (CASE WHEN m.is_starred = 1 THEN 1.15 ELSE 1.0 END)
      * (CASE WHEN m.is_read = 0 THEN 1.08 ELSE 1.0 END)`;
}

const RESULT_COLUMNS = [
  "message_id",
  "account_id",
  "thread_id",
  "subject",
  "from_name",
  "from_address",
  "snippet",
  "date",
];

/**
 * Build a parameterized SQL query from a parsed search query.
 * Returns { sql, params } for safe execution.
 */
export function buildSearchQuery(
  parsed: ParsedSearchQuery,
  options: BuildSearchOptions = {},
): BuiltQuery {
  const {
    accountId,
    limit = 50,
    sort = "relevance",
    groupByThread = false,
    matchMode = "all",
  } = options;

  const params: unknown[] = [];
  let paramIdx = 1;

  const whereClauses: string[] = [];
  let needsFts = false;

  // Base query - we'll add FTS join conditionally
  let fromClause = "FROM messages m";

  // Free text search via FTS5. The raw text is never passed through: FTS5
  // would parse it as a query expression and throw on an email address, a
  // filename, or an apostrophe. See ./ftsQuery.ts.
  const fts = buildFtsQuery(parsed.freeText, matchMode);
  if (fts.match) {
    needsFts = true;
    fromClause = "FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid";
    whereClauses.push(`messages_fts MATCH $${paramIdx}`);
    params.push(fts.match);
    paramIdx++;
  } else if (fts.tooShort) {
    // Every term was below the trigram window (e.g. "ok", "hi"). FTS5 cannot
    // match those at all, so fall back to a substring scan of the fields a
    // one- or two-letter search plausibly targets.
    const needle = parsed.freeText.trim();
    whereClauses.push(
      `(m.subject LIKE '%' || $${paramIdx} || '%'
        OR m.from_name LIKE '%' || $${paramIdx} || '%'
        OR m.from_address LIKE '%' || $${paramIdx} || '%')`,
    );
    params.push(needle);
    paramIdx++;
  }

  // Account filter
  if (Array.isArray(accountId)) {
    if (accountId.length > 0) {
      const placeholders = accountId.map((_, i) => `$${paramIdx + i}`).join(", ");
      whereClauses.push(`m.account_id IN (${placeholders})`);
      params.push(...accountId);
      paramIdx += accountId.length;
    }
  } else if (accountId) {
    whereClauses.push(`m.account_id = $${paramIdx}`);
    params.push(accountId);
    paramIdx++;
  }

  // from: operator
  if (parsed.from) {
    whereClauses.push(`(m.from_address LIKE '%' || $${paramIdx} || '%' OR m.from_name LIKE '%' || $${paramIdx} || '%')`);
    params.push(parsed.from);
    paramIdx++;
  }

  // to: operator
  if (parsed.to) {
    whereClauses.push(`m.to_addresses LIKE '%' || $${paramIdx} || '%'`);
    params.push(parsed.to);
    paramIdx++;
  }

  // subject: operator
  if (parsed.subject) {
    whereClauses.push(`m.subject LIKE '%' || $${paramIdx} || '%'`);
    params.push(parsed.subject);
    paramIdx++;
  }

  // has:attachment — exclude inline CID images (e.g. signature logos)
  if (parsed.hasAttachment) {
    whereClauses.push(
      `EXISTS (SELECT 1 FROM attachments a WHERE a.account_id = m.account_id AND a.message_id = m.id AND a.is_inline = 0)`,
    );
  }

  // has:calendar — messages with .ics attachments or calendar MIME type
  if (parsed.hasCalendar) {
    whereClauses.push(
      `EXISTS (SELECT 1 FROM attachments a WHERE a.account_id = m.account_id AND a.message_id = m.id AND (a.mime_type LIKE '%calendar%' OR a.filename LIKE '%.ics'))`,
    );
  }

  // is:unread
  if (parsed.isUnread) {
    whereClauses.push(`m.is_read = 0`);
    whereClauses.push(`m.is_draft = 0`);
  }

  // is:read
  if (parsed.isRead) {
    whereClauses.push(`m.is_read = 1`);
  }

  // is:starred
  if (parsed.isStarred) {
    whereClauses.push(`m.is_starred = 1`);
  }

  // is:ricevuta — PEC receipts
  if (parsed.isPecReceipt) {
    whereClauses.push(`m.is_pec_receipt = 1`);
  }

  // before: date
  if (parsed.before !== undefined) {
    whereClauses.push(`m.date < $${paramIdx}`);
    params.push(parsed.before);
    paramIdx++;
  }

  // after: date
  if (parsed.after !== undefined) {
    whereClauses.push(`m.date > $${paramIdx}`);
    params.push(parsed.after);
    paramIdx++;
  }

  // label: operator
  if (parsed.label) {
    whereClauses.push(
      `EXISTS (SELECT 1 FROM thread_labels tl JOIN labels l ON l.account_id = tl.account_id AND l.id = tl.label_id WHERE tl.account_id = m.account_id AND tl.thread_id = m.thread_id AND LOWER(l.name) = LOWER($${paramIdx}))`,
    );
    params.push(parsed.label);
    paramIdx++;
  }

  // in: operator — pin the search to one system folder. "ANYWHERE" only lifts
  // the default exclusion below and adds no clause of its own.
  if (parsed.in && parsed.in !== "ANYWHERE") {
    whereClauses.push(
      `EXISTS (SELECT 1 FROM thread_labels tli WHERE tli.account_id = m.account_id AND tli.thread_id = m.thread_id AND tli.label_id = $${paramIdx})`,
    );
    params.push(parsed.in);
    paramIdx++;
  }

  // Exclude TRASH and SPAM unless the query explicitly targets those labels.
  // DRAFT is excluded only for pure-draft threads (DRAFT without INBOX) — threads
  // with a draft reply in progress (DRAFT + INBOX) should still appear in smart folders.
  const targetsSystemFolder =
    !!parsed.label ||
    parsed.in === "TRASH" ||
    parsed.in === "SPAM" ||
    parsed.in === "DRAFT" ||
    parsed.in === "ANYWHERE";
  if ((options.excludeSystemLabels ?? false) && !targetsSystemFolder) {
    // Exclude threads that are in TRASH/SPAM but NOT in INBOX (fully trashed/spammed threads).
    // Threads with both INBOX and TRASH are valid (some messages individually trashed) and must
    // still appear in smart folders and badge counts.
    whereClauses.push(
      `NOT (EXISTS (SELECT 1 FROM thread_labels tl2 WHERE tl2.account_id = m.account_id AND tl2.thread_id = m.thread_id AND tl2.label_id IN ('TRASH', 'SPAM')) AND NOT EXISTS (SELECT 1 FROM thread_labels tl2i WHERE tl2i.account_id = m.account_id AND tl2i.thread_id = m.thread_id AND tl2i.label_id = 'INBOX'))`,
    );
    whereClauses.push(
      `NOT (EXISTS (SELECT 1 FROM thread_labels tl3 WHERE tl3.account_id = m.account_id AND tl3.thread_id = m.thread_id AND tl3.label_id = 'DRAFT') AND NOT EXISTS (SELECT 1 FROM thread_labels tl4 WHERE tl4.account_id = m.account_id AND tl4.thread_id = m.thread_id AND tl4.label_id = 'INBOX'))`,
    );
  }

  const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
  const whereParams = [...params];

  // Relevance needs something to score; without a MATCH there is no bm25 to
  // read, so a date listing is the only meaningful order.
  const useRelevance = sort === "relevance" && needsFts;

  let scoreSql: string;
  if (useRelevance) {
    scoreSql = scoreExpression(`$${paramIdx}`);
    params.push(Date.now());
    paramIdx++;
  } else {
    // Sorting by score DESC then equals date DESC, so the two paths share one
    // shape — including the MAX(score) group-by, which picks each thread's
    // most recent message.
    scoreSql = "m.date";
  }

  // The scored rows always go through a CTE: `messages_fts` itself exposes a
  // column called `rank`, so scoring in the outer SELECT would make the name
  // ambiguous. Inside the CTE the score is `score`; only the outer projection
  // renames it to `rank` for the SearchResult shape.
  // MATERIALIZED, always: left to itself SQLite may flatten the CTE into the
  // outer query, and when that outer query aggregates it moves bm25() into an
  // aggregate context where FTS5 refuses to evaluate it ("unable to use
  // function bm25 in the requested context"). Pinning it costs a scored pass
  // over the matches — tens of milliseconds — and takes the query plan out of
  // the correctness argument entirely.
  const hitsCte = `WITH hits AS MATERIALIZED (
    SELECT m.id as message_id,
      m.account_id,
      m.thread_id,
      m.subject,
      m.from_name,
      m.from_address,
      m.snippet,
      m.date,
      ${scoreSql} as score
    ${fromClause}
    ${whereStr}
  )`;

  const sql = groupByThread
    // One row per thread, keeping the best-scoring message of each. SQLite
    // resolves the bare columns from the row that produced MAX(score).
    ? `${hitsCte}
  SELECT ${RESULT_COLUMNS.join(", ")}, MAX(score) as rank
  FROM hits
  GROUP BY account_id, thread_id
  ORDER BY rank DESC, date DESC
  LIMIT $${paramIdx}`
    : `${hitsCte}
  SELECT DISTINCT ${RESULT_COLUMNS.join(", ")}, score as rank
  FROM hits
  ORDER BY rank DESC, date DESC
  LIMIT $${paramIdx}`;

  params.push(limit);

  return {
    sql,
    params,
    fromSql: fromClause,
    whereSql: whereStr,
    whereParams,
    tooShort: fts.tooShort,
  };
}
