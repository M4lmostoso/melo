import { getDb, withTransaction } from "./connection";

/**
 * Deferred user-label assignments for cross-account moves into IMAP targets.
 *
 * IMAP has no server-side custom labels — they live purely in the local DB
 * (`user_labels` + `thread_labels`). When a thread is moved cross-account the
 * destination message is APPENDed and only materializes locally after the next
 * sync, so we cannot write `thread_labels` immediately (the target thread_id
 * does not exist yet). Instead we record a pending assignment keyed by the
 * message's RFC Message-ID header and apply it once sync has imported the
 * message and assigned it a thread.
 *
 * Gmail targets do not use this — their labels are applied server-side via the
 * Gmail API on insert, since Gmail sync rebuilds `thread_labels` from
 * `gmail_label_ids` and would wipe any local-only rows.
 */

const STALE_AFTER_SECONDS = 7 * 24 * 60 * 60; // prune entries never matched within a week

export async function addPendingLabelAssignments(
  accountId: string,
  messageIdHeader: string,
  labelIds: string[],
): Promise<void> {
  if (!messageIdHeader || labelIds.length === 0) return;
  await withTransaction(async (db) => {
    for (const labelId of labelIds) {
      await db.execute(
        `INSERT OR IGNORE INTO pending_label_assignments
           (account_id, message_id_header, label_id)
         VALUES ($1, $2, $3)`,
        [accountId, messageIdHeader, labelId],
      );
    }
  });
}

/**
 * Apply any pending assignments whose target message has been synced (now has a
 * thread_id) and whose label still exists. Each applied row inserts a
 * `thread_labels` entry and is then removed. Stale rows (message never arrived)
 * are pruned after a week.
 */
export async function applyPendingLabelAssignments(accountId: string): Promise<void> {
  const db = await getDb();

  const rows = await db.select<{ thread_id: string; label_id: string; message_id_header: string }[]>(
    `SELECT DISTINCT m.thread_id, pla.label_id, pla.message_id_header
       FROM pending_label_assignments pla
       INNER JOIN messages m
         ON m.account_id = pla.account_id
        AND m.message_id_header = pla.message_id_header
        AND m.thread_id IS NOT NULL
       INNER JOIN user_labels ul
         ON ul.account_id = pla.account_id
        AND ul.id = pla.label_id
       WHERE pla.account_id = $1`,
    [accountId],
  );

  if (rows.length > 0) {
    await withTransaction(async (db) => {
      for (const { thread_id, label_id, message_id_header } of rows) {
        await db.execute(
          `INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id)
           VALUES ($1, $2, $3)`,
          [accountId, thread_id, label_id],
        );
        await db.execute(
          `DELETE FROM pending_label_assignments
           WHERE account_id = $1 AND message_id_header = $2 AND label_id = $3`,
          [accountId, message_id_header, label_id],
        );
      }
    });
  }

  // Prune entries that never matched a synced message.
  await db.execute(
    `DELETE FROM pending_label_assignments
     WHERE account_id = $1 AND created_at < unixepoch() - $2`,
    [accountId, STALE_AFTER_SECONDS],
  );
}
