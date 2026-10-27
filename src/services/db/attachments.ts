import { getDb, withTransaction } from "./connection";

export interface DbAttachment {
  id: string;
  message_id: string;
  account_id: string;
  filename: string | null;
  mime_type: string | null;
  size: number | null;
  gmail_attachment_id: string | null;
  imap_part_id: string | null;
  content_id: string | null;
  is_inline: number;
  local_path: string | null;
}

export async function upsertAttachment(att: {
  id: string;
  messageId: string;
  accountId: string;
  filename: string | null;
  mimeType: string | null;
  size: number | null;
  gmailAttachmentId: string | null;
  imapPartId: string | null;
  contentId: string | null;
  isInline: boolean;
}): Promise<void> {
  await withTransaction(async (db) => {
    await db.execute(
      `INSERT INTO attachments (id, message_id, account_id, filename, mime_type, size, gmail_attachment_id, imap_part_id, content_id, is_inline)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT(id) DO UPDATE SET
         filename = $4, mime_type = $5, size = $6,
         gmail_attachment_id = $7, imap_part_id = $8, content_id = $9, is_inline = $10`,
      [
        att.id,
        att.messageId,
        att.accountId,
        att.filename,
        att.mimeType,
        att.size,
        att.gmailAttachmentId,
        att.imapPartId,
        att.contentId,
        att.isInline ? 1 : 0,
      ],
    );
  });
}

export interface AttachmentWithContext {
  id: string;
  message_id: string;
  account_id: string;
  filename: string | null;
  mime_type: string | null;
  size: number | null;
  gmail_attachment_id: string | null;
  imap_part_id: string | null;
  content_id: string | null;
  is_inline: number;
  local_path: string | null;
  from_address: string | null;
  from_name: string | null;
  date: number | null;
  subject: string | null;
  thread_id: string | null;
}

export type AttachmentTypeFilter = "all" | "images" | "pdfs" | "documents" | "spreadsheets" | "archives" | "other";
export type AttachmentDateFilter = "all" | "today" | "week" | "month" | "year";
export type AttachmentSizeFilter = "all" | "small" | "medium" | "large";

export interface AttachmentFilters {
  /** Free text: every word must appear in the filename, the subject or the sender. */
  query?: string;
  type?: AttachmentTypeFilter;
  /** Exact sender address. */
  sender?: string | null;
  date?: AttachmentDateFilter;
  size?: AttachmentSizeFilter;
}

/**
 * The library never shows attachments of mail in Trash or Spam — the mail
 * search excludes those folders too. Trash is a per-message flag; Spam is not,
 * so it is recognised by the account's Spam/Trash folder (IMAP) or by the
 * message's own label ids (Gmail). Never the thread labels: a Gmail thread can
 * be INBOX and TRASH at once.
 */
const NOT_TRASH_OR_SPAM = `m.is_trashed = 0
       AND NOT EXISTS (SELECT 1 FROM labels l WHERE l.account_id = m.account_id
         AND l.id IN ('TRASH', 'SPAM') AND l.imap_folder_path = m.imap_folder)
       AND COALESCE(m.gmail_label_ids, '') NOT LIKE '%"SPAM"%'
       AND COALESCE(m.gmail_label_ids, '') NOT LIKE '%"TRASH"%'`;

/** Page size for the attachment library. Applied AFTER filtering, never before. */
export const ATTACHMENT_PAGE_SIZE = 200;

// SQL mirrors of the fileTypeHelpers predicates. Inputs are COALESCEd so a NULL
// mime type cannot turn a NOT(...) into NULL and drop the row from "other".
const MIME = "COALESCE(a.mime_type, '')";
const NAME = "LOWER(COALESCE(a.filename, ''))";
const mimeHas = (...parts: string[]) => parts.map((p) => `INSTR(${MIME}, '${p}') > 0`);
const mimeIs = (...types: string[]) => types.map((t) => `${MIME} = '${t}'`);
const extIs = (...exts: string[]) => exts.map((e) => `${NAME} LIKE '%.${e}'`);
const anyOf = (conds: string[]) => `(${conds.join(" OR ")})`;

const TYPE_SQL: Record<Exclude<AttachmentTypeFilter, "all" | "other">, string> = {
  images: `${MIME} LIKE 'image/%'`,
  pdfs: anyOf([...mimeIs("application/pdf"), ...extIs("pdf")]),
  documents: anyOf([
    ...mimeHas("msword", "wordprocessingml", "opendocument.text"),
    ...mimeIs("application/rtf"),
    ...extIs("doc", "docx", "odt", "rtf"),
  ]),
  spreadsheets: anyOf([
    ...mimeHas("spreadsheet", "excel"),
    ...mimeIs("text/csv"),
    ...extIs("xls", "xlsx", "ods", "csv"),
  ]),
  archives: anyOf([
    ...mimeHas("zip", "compressed", "archive", "tar"),
    ...mimeIs("application/gzip", "application/x-gzip"),
    ...extIs("zip", "rar", "7z", "tar", "gz", "bz2"),
  ]),
};

const DAY_MS = 86_400_000;
const DATE_WINDOW_MS: Record<Exclude<AttachmentDateFilter, "all">, number> = {
  today: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
  year: 365 * DAY_MS,
};

const MB = 1_048_576;

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Accent folding for the attachment search. SQLite has no unaccent() and the
 * SQL plugin cannot register one, so both sides are folded the same way: the
 * search text in JS, the columns in SQL through a REPLACE chain. Without it
 * "perche" missed "perché", and LOWER() — ASCII-only in SQLite — left "È" as is.
 */
const ACCENTED =
  "àáâãäåāăąèéêëēėęěìíîïīįòóôõöøōùúûüūůųýÿñńňçćčśšźżžłđß" +
  "ÀÁÂÃÄÅĀĂĄÈÉÊËĒĖĘĚÌÍÎÏĪĮÒÓÔÕÖØŌÙÚÛÜŪŮŲÝŸÑŃŇÇĆČŚŠŹŻŽŁĐ";
const COMBINING_MARKS = "\u0300\u0301\u0302\u0303\u0304\u0306\u0308\u030A\u030C\u0327\u0328";
const SPECIAL_FOLDS: Record<string, string> = { ø: "o", Ø: "o", ł: "l", Ł: "l", đ: "d", Đ: "d", ß: "ss" };

export function foldForSearch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[øØłŁđĐß]/g, (c) => SPECIAL_FOLDS[c]!)
    .toLowerCase();
}

/** SQL counterpart of foldForSearch for a column expression. */
function foldSql(expr: string): string {
  // Decomposed input (common in filenames from macOS) carries the accent as a
  // separate combining mark: drop the mark, the base letter is already plain.
  let sql = expr;
  for (const mark of COMBINING_MARKS) sql = `REPLACE(${sql}, '${mark}', '')`;
  for (const ch of ACCENTED) sql = `REPLACE(${sql}, '${ch}', '${foldForSearch(ch)}')`;
  // The chain costs ~60 REPLACE calls per value; most values are plain ASCII,
  // so only those carrying a non-ASCII character pay for it (~350 ms → fast).
  return `CASE WHEN ${expr} GLOB '*[^ -~]*' THEN LOWER(${sql}) ELSE LOWER(${expr}) END`;
}

const SEARCH_COLUMNS = ["a.filename", "m.subject", "m.from_name", "m.from_address"].map((c) =>
  foldSql(`COALESCE(${c}, '')`),
);

/**
 * Build the shared FROM/WHERE for the attachment library. Every filter runs in
 * SQL so search covers the whole archive — filtering a pre-fetched page made
 * anything older than the newest 200 attachments unfindable.
 */
function buildAttachmentWhere(
  accountIds: string[],
  filters: AttachmentFilters,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [...accountIds];
  const next = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  const placeholders = accountIds.map((_, i) => `$${i + 1}`).join(", ");
  const where = [
    `a.account_id IN (${placeholders})`,
    "a.filename IS NOT NULL AND a.filename != ''",
    "a.is_inline = 0 AND a.content_id IS NULL",
    NOT_TRASH_OR_SPAM,
  ];

  const words = foldForSearch(filters.query ?? "").trim().split(/\s+/).filter(Boolean);
  for (const word of words) {
    const p = next(`%${escapeLike(word)}%`);
    where.push(`(${SEARCH_COLUMNS.map((col) => `${col} LIKE ${p} ESCAPE '\\'`).join(" OR ")})`);
  }

  const type = filters.type ?? "all";
  if (type === "other") {
    where.push(`NOT ${anyOf(Object.values(TYPE_SQL))}`);
  } else if (type !== "all") {
    where.push(TYPE_SQL[type]);
  }

  if (filters.sender) where.push(`m.from_address = ${next(filters.sender)}`);

  const date = filters.date ?? "all";
  // Undated messages stay visible under every window, as before.
  if (date !== "all") where.push(`(m.date IS NULL OR m.date > ${next(Date.now() - DATE_WINDOW_MS[date])})`);

  switch (filters.size ?? "all") {
    case "small": where.push(`COALESCE(a.size, 0) < ${MB}`); break;
    case "medium": where.push(`COALESCE(a.size, 0) BETWEEN ${MB} AND ${10 * MB}`); break;
    case "large": where.push(`COALESCE(a.size, 0) > ${10 * MB}`); break;
  }

  return {
    sql: `FROM attachments a
     JOIN messages m ON a.message_id = m.id AND a.account_id = m.account_id
     WHERE ${where.join("\n       AND ")}`,
    params,
  };
}

/** One page of the attachment library, newest first, with every filter applied in SQL. */
export async function searchAttachments(
  accountIds: string[],
  filters: AttachmentFilters = {},
  limit = ATTACHMENT_PAGE_SIZE,
  offset = 0,
): Promise<AttachmentWithContext[]> {
  if (accountIds.length === 0) return [];
  const db = await getDb();
  const { sql, params } = buildAttachmentWhere(accountIds, filters);
  const n = params.length;
  return db.select<AttachmentWithContext[]>(
    `SELECT a.*, m.from_address, m.from_name, m.date, m.subject, m.thread_id
     ${sql}
     ORDER BY m.date DESC, a.id
     LIMIT $${n + 1} OFFSET $${n + 2}`,
    [...params, limit, offset],
  );
}

/** Total number of attachments matching the filters (across all pages). */
export async function countAttachments(
  accountIds: string[],
  filters: AttachmentFilters = {},
): Promise<number> {
  if (accountIds.length === 0) return 0;
  const db = await getDb();
  const { sql, params } = buildAttachmentWhere(accountIds, filters);
  const rows = await db.select<{ count: number }[]>(`SELECT COUNT(*) as count ${sql}`, params);
  return rows[0]?.count ?? 0;
}

export interface AttachmentSender {
  from_address: string;
  from_name: string | null;
  count: number;
}

export async function getAttachmentSenders(
  accountId: string,
): Promise<AttachmentSender[]> {
  const db = await getDb();
  return db.select<AttachmentSender[]>(
    `SELECT m.from_address, m.from_name, COUNT(*) as count
     FROM attachments a
     JOIN messages m ON a.message_id = m.id AND a.account_id = m.account_id
     WHERE a.account_id = $1 AND a.filename IS NOT NULL AND a.filename != ''
       AND a.is_inline = 0 AND a.content_id IS NULL
       AND m.from_address IS NOT NULL
       AND ${NOT_TRASH_OR_SPAM}
     GROUP BY m.from_address
     ORDER BY count DESC`,
    [accountId],
  );
}

/** Unified-view variant: aggregate senders across multiple accounts. */
export async function getAttachmentSendersForAccounts(
  accountIds: string[],
): Promise<AttachmentSender[]> {
  if (accountIds.length === 0) return [];
  const db = await getDb();
  const placeholders = accountIds.map((_, i) => `$${i + 1}`).join(", ");
  return db.select<AttachmentSender[]>(
    `SELECT m.from_address, m.from_name, COUNT(*) as count
     FROM attachments a
     JOIN messages m ON a.message_id = m.id AND a.account_id = m.account_id
     WHERE a.account_id IN (${placeholders}) AND a.filename IS NOT NULL AND a.filename != ''
       AND a.is_inline = 0 AND a.content_id IS NULL
       AND m.from_address IS NOT NULL
       AND ${NOT_TRASH_OR_SPAM}
     GROUP BY m.from_address
     ORDER BY count DESC`,
    accountIds,
  );
}

export async function getAttachmentsForMessage(
  accountId: string,
  messageId: string,
): Promise<DbAttachment[]> {
  const db = await getDb();
  return db.select<DbAttachment[]>(
    "SELECT * FROM attachments WHERE account_id = $1 AND message_id = $2 ORDER BY filename ASC",
    [accountId, messageId],
  );
}

export async function getAttachmentById(id: string): Promise<DbAttachment | null> {
  const db = await getDb();
  const rows = await db.select<DbAttachment[]>(
    "SELECT * FROM attachments WHERE id = $1 LIMIT 1",
    [id],
  );
  return rows[0] ?? null;
}
