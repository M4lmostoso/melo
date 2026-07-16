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

export async function getAttachmentsForAccount(
  accountId: string,
  limit = 200,
  offset = 0,
): Promise<AttachmentWithContext[]> {
  const db = await getDb();
  return db.select<AttachmentWithContext[]>(
    `SELECT a.*, m.from_address, m.from_name, m.date, m.subject, m.thread_id
     FROM attachments a
     JOIN messages m ON a.message_id = m.id AND a.account_id = m.account_id
     WHERE a.account_id = $1 AND a.filename IS NOT NULL AND a.filename != ''
       AND a.is_inline = 0 AND a.content_id IS NULL
     ORDER BY m.date DESC
     LIMIT $2 OFFSET $3`,
    [accountId, limit, offset],
  );
}

/** Unified-view variant: load attachments across multiple accounts at once. */
export async function getAttachmentsForAccounts(
  accountIds: string[],
  limit = 200,
  offset = 0,
): Promise<AttachmentWithContext[]> {
  if (accountIds.length === 0) return [];
  const db = await getDb();
  const placeholders = accountIds.map((_, i) => `$${i + 1}`).join(", ");
  return db.select<AttachmentWithContext[]>(
    `SELECT a.*, m.from_address, m.from_name, m.date, m.subject, m.thread_id
     FROM attachments a
     JOIN messages m ON a.message_id = m.id AND a.account_id = m.account_id
     WHERE a.account_id IN (${placeholders}) AND a.filename IS NOT NULL AND a.filename != ''
       AND a.is_inline = 0 AND a.content_id IS NULL
     ORDER BY m.date DESC
     LIMIT $${accountIds.length + 1} OFFSET $${accountIds.length + 2}`,
    [...accountIds, limit, offset],
  );
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
