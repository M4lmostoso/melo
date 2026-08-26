import { getDb } from "./connection";
import { parseSearchQuery } from "../search/searchParser";
import { buildSearchQuery } from "../search/searchQueryBuilder";

export interface SenderSuggestion {
  from_address: string;
  from_name: string | null;
  message_count: number;
}

/**
 * Search distinct senders in threads with a given label (e.g. 'INBOX').
 * - labelId null  → search across all messages (allmail context)
 * - accountId null → search across all accounts (unified-inbox context)
 */
export async function searchSendersByLabel(
  query: string,
  accountId: string | null,
  labelId: string | null,
  limit = 6,
): Promise<SenderSuggestion[]> {
  if (!query.trim()) return [];
  const db = await getDb();
  const q = query.trim();

  // Build WHERE clauses dynamically to handle null accountId / labelId
  const conditions: string[] = [
    "m.from_address != ''",
    "(LOWER(m.from_name) LIKE '%' || LOWER($1) || '%' OR LOWER(m.from_address) LIKE '%' || LOWER($1) || '%')",
  ];
  const params: unknown[] = [q];
  let idx = 2;

  if (accountId) {
    conditions.push(`m.account_id = $${idx++}`);
    params.push(accountId);
  }

  const fromClause = labelId
    ? `FROM messages m JOIN thread_labels tl ON tl.account_id = m.account_id AND tl.thread_id = m.thread_id AND tl.label_id = $${idx++}`
    : `FROM messages m`;

  if (labelId) params.push(labelId);

  params.push(limit);

  return db.select<SenderSuggestion[]>(
    `SELECT m.from_address, m.from_name, COUNT(*) as message_count
     ${fromClause}
     WHERE ${conditions.join(" AND ")}
     GROUP BY m.from_address
     ORDER BY message_count DESC
     LIMIT $${idx}`,
    params,
  );
}

export interface RecipientSuggestion {
  address: string;
  name: string | null;
  message_count: number;
}

/**
 * Parse a raw To/Cc address header string into individual address entries.
 * Handles "Name <email>" and bare "email" formats.
 */
function parseAddressHeader(raw: string): Array<{ address: string; name: string | null }> {
  // Split on commas that are not inside angle brackets
  const parts = raw.split(/,(?![^<]*>)/);
  const results: Array<{ address: string; name: string | null }> = [];
  for (const part of parts) {
    const p = part.trim();
    const namedMatch = p.match(/^"?([^"<>]*?)"?\s*<([^>]+)>\s*$/);
    if (namedMatch) {
      const name = namedMatch[1]!.trim() || null;
      const address = namedMatch[2]!.trim().toLowerCase();
      if (address.includes("@")) results.push({ name, address });
      continue;
    }
    const emailMatch = p.match(/^[\w.+\-']+@[\w.\-]+\.[a-z]{2,}$/i);
    if (emailMatch) {
      results.push({ name: null, address: p.toLowerCase() });
    }
  }
  return results;
}

/**
 * Search distinct recipients in SENT threads whose name or address matches the query.
 * Fetches raw to_addresses strings from DB and parses them in JS.
 * accountId null → search across all accounts.
 */
export async function searchSentRecipients(
  query: string,
  accountId: string | null,
  limit = 6,
): Promise<RecipientSuggestion[]> {
  if (!query.trim()) return [];
  const db = await getDb();
  const q = query.trim().toLowerCase();

  const accountClause = accountId ? "AND m.account_id = $3" : "";
  const params: unknown[] = [q, accountId ? 300 : 300];
  if (accountId) params.splice(1, 0, accountId); // insert before limit

  const rows = await db.select<Array<{ to_addresses: string }>>(
    `SELECT m.to_addresses
     FROM messages m
     JOIN thread_labels tl
       ON tl.account_id = m.account_id
      AND tl.thread_id  = m.thread_id
      AND tl.label_id   = 'SENT'
     WHERE m.to_addresses IS NOT NULL
       AND m.to_addresses != ''
       AND LOWER(m.to_addresses) LIKE '%' || $1 || '%'
       ${accountClause}
     LIMIT $${accountId ? 3 : 2}`,
    accountId ? [q, accountId, 300] : [q, 300],
  );

  // Parse all address strings, keep only those matching the query, count occurrences
  const counts = new Map<string, { name: string | null; count: number }>();
  for (const row of rows) {
    for (const { address, name } of parseAddressHeader(row.to_addresses)) {
      if (!address.includes(q) && !(name ?? "").toLowerCase().includes(q)) continue;
      const existing = counts.get(address);
      if (existing) {
        existing.count++;
        if (!existing.name && name) existing.name = name;
      } else {
        counts.set(address, { name, count: 1 });
      }
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, limit)
    .map(([address, { name, count }]) => ({ address, name, message_count: count }));
}

export interface DomainAccountHistory {
  account_id: string;
  count: number;
}

/**
 * For each SENT message addressed to `domain` (matched as the exact domain
 * after '@', not a substring), count how many were sent from each account.
 * Used to detect an "unusual sender account" for brand-new compose messages —
 * see services/composer/unusualAccountCheck.ts.
 */
export async function getSentAccountIdsForDomain(
  domain: string,
  limit = 500,
): Promise<DomainAccountHistory[]> {
  const db = await getDb();
  const d = domain.toLowerCase();

  const rows = await db.select<Array<{ account_id: string; to_addresses: string }>>(
    `SELECT m.account_id, m.to_addresses
     FROM messages m
     JOIN thread_labels tl
       ON tl.account_id = m.account_id
      AND tl.thread_id  = m.thread_id
      AND tl.label_id   = 'SENT'
     WHERE m.to_addresses IS NOT NULL
       AND m.to_addresses != ''
       AND LOWER(m.to_addresses) LIKE '%' || $1 || '%'
     ORDER BY m.date DESC
     LIMIT $2`,
    [d, limit],
  );

  const emailRegex = /[\w.+'-]+@([\w.-]+\.[a-z]{2,})/gi;
  const counts = new Map<string, number>();
  for (const row of rows) {
    const matches = [...row.to_addresses.matchAll(emailRegex)];
    const hasDomain = matches.some((m) => m[1]?.toLowerCase() === d);
    if (!hasDomain) continue;
    counts.set(row.account_id, (counts.get(row.account_id) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([account_id, count]) => ({ account_id, count }))
    .sort((a, b) => b.count - a.count);
}

export interface SearchResult {
  message_id: string;
  account_id: string;
  thread_id: string;
  subject: string | null;
  from_name: string | null;
  from_address: string | null;
  snippet: string | null;
  date: number;
  rank: number;
}

export interface SearchOptions {
  accountId?: string;
  limit?: number;
  /**
   * "relevance" (default) ranks by weighted BM25 with a recency/attention
   * multiplier; "date" is a straight reverse-chronological listing.
   */
  sort?: "relevance" | "date";
  /** Collapse to one row per thread, keeping each thread's best message. */
  groupByThread?: boolean;
  /**
   * Include threads that live only in Trash/Spam. Off by default — deleted
   * copies of a mail are noise in a search, and the user can ask for them
   * explicitly with `in:trash` / `in:anywhere`.
   */
  includeSystemFolders?: boolean;
  /**
   * "all" (default) requires every term; "any" is the higher-recall mode used
   * by the AI question path, whose terms are extracted rather than typed.
   */
  matchMode?: "all" | "any";
}

/**
 * Full-text search across messages using FTS5.
 * Supports search operators: from:, to:, subject:, has:attachment, is:unread,
 * in:trash, and the rest handled by parseSearchQuery.
 *
 * The query text is always routed through buildFtsQuery — passing raw user
 * input to `messages_fts MATCH` makes FTS5 parse it as a query expression,
 * which throws on an email address, a filename or an apostrophe.
 */
export async function searchMessages(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const db = await getDb();

  const trimmed = query.trim();
  if (!trimmed) return [];

  const parsed = parseSearchQuery(trimmed);

  // Nothing to search on: no free text and no operator narrowed anything down.
  const hasAnyFilter =
    parsed.freeText.trim() !== "" ||
    parsed.from !== undefined ||
    parsed.to !== undefined ||
    parsed.subject !== undefined ||
    parsed.hasAttachment ||
    parsed.hasCalendar ||
    parsed.isUnread ||
    parsed.isRead ||
    parsed.isStarred ||
    parsed.isPecReceipt ||
    parsed.before !== undefined ||
    parsed.after !== undefined ||
    parsed.label !== undefined ||
    parsed.in !== undefined;
  if (!hasAnyFilter) return [];

  const { sql, params } = buildSearchQuery(parsed, {
    accountId: options.accountId,
    limit: options.limit ?? 50,
    sort: options.sort ?? "relevance",
    groupByThread: options.groupByThread ?? false,
    excludeSystemLabels: !options.includeSystemFolders,
    matchMode: options.matchMode ?? "all",
  });

  return db.select<SearchResult[]>(sql, params);
}

/**
 * Body excerpts for a set of messages, keyed by message id.
 *
 * The AI question path used to build its context from `snippet` alone — about
 * a hundred characters — so the model was asked when a contract expires while
 * being shown only a subject line and the opening greeting. This gives it the
 * actual text.
 */
export async function getMessageExcerpts(
  refs: Array<{ accountId: string; messageId: string }>,
  maxChars = 1200,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (refs.length === 0) return out;

  const db = await getDb();
  const placeholders = refs.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(", ");
  const params = refs.flatMap((r) => [r.accountId, r.messageId]);

  const rows = await db.select<Array<{ id: string; body_text: string | null; snippet: string | null }>>(
    `SELECT id, body_text, snippet FROM messages
     WHERE (account_id, id) IN (VALUES ${placeholders})`,
    params,
  );

  for (const row of rows) {
    const raw = (row.body_text ?? row.snippet ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z#0-9]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (raw) out.set(row.id, raw.slice(0, maxChars));
  }

  return out;
}
