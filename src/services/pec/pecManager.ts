// PEC mode orchestration: enable/disable per account, and the reconcile step that
// keeps certified-mail receipts out of the Inbox, always read, and flagged so the
// "Ricevute" smart folder (query `is:ricevuta`) can surface them.
//
// Receipts are persisted by the normal sync like any other message; this module
// runs AFTER storage (post-sync hook + enable-time backfill) and reconciles them.

import { getDb } from "../db/connection";
import { getAccountPecEnabled, setAccountPecEnabled } from "../db/accounts";
import { pecReceiptSqlPredicate } from "./pecReceipts";

/**
 * Id of the single, global (account_id IS NULL) auto-managed "Ricevute" smart
 * folder. Global so it shows both in the unified view and under each PEC account;
 * the sidebar hides it under non-PEC single accounts. Its `is:ricevuta` query
 * only matches PEC receipts, so non-PEC accounts contribute nothing.
 */
export const RICEVUTE_FOLDER_ID = "sf-ricevute";

/**
 * Reconcile PEC receipts for an account: flag them, force them read, and strip
 * the INBOX label from threads that consist solely of receipts. No-op unless the
 * account has PEC mode enabled. Idempotent — safe to call after every sync.
 */
export async function reconcilePecReceipts(accountId: string): Promise<void> {
  if (!(await getAccountPecEnabled(accountId))) return;
  const db = await getDb();
  const predicate = pecReceiptSqlPredicate("messages");

  // 1. Flag receipts and force them read.
  await db.execute(
    `UPDATE messages SET is_pec_receipt = 1, is_read = 1
     WHERE account_id = $1 AND ${predicate} AND (is_pec_receipt = 0 OR is_read = 0)`,
    [accountId],
  );

  // 2. Remove INBOX from threads that have a receipt and no non-receipt, non-trashed
  //    message (receipts are single-message threads, so the guard is just safety).
  await db.execute(
    `DELETE FROM thread_labels
     WHERE account_id = $1 AND label_id = 'INBOX'
       AND thread_id IN (
         SELECT DISTINCT thread_id FROM messages
         WHERE account_id = $1 AND is_pec_receipt = 1
       )
       AND thread_id NOT IN (
         SELECT DISTINCT thread_id FROM messages
         WHERE account_id = $1 AND is_pec_receipt = 0 AND is_trashed = 0
       )`,
    [accountId],
  );

  // 3. Mark receipt-only threads read so they never contribute an unread badge.
  await db.execute(
    `UPDATE threads SET is_read = 1
     WHERE account_id = $1 AND id IN (
       SELECT DISTINCT thread_id FROM messages
       WHERE account_id = $1 AND is_pec_receipt = 1
     )`,
    [accountId],
  );
}

/**
 * Enable PEC mode for an account: create the "Ricevute" smart folder and backfill
 * existing receipts (moving any already in the Inbox into the folder).
 */
export async function enablePec(accountId: string): Promise<void> {
  await setAccountPecEnabled(accountId, true);
  const db = await getDb();
  await db.execute(
    `INSERT OR IGNORE INTO smart_folders (id, account_id, name, query, icon, is_default)
     VALUES ($1, NULL, 'Ricevute', 'is:ricevuta', 'ReceiptText', 1)`,
    [RICEVUTE_FOLDER_ID],
  );
  await reconcilePecReceipts(accountId);
}

/**
 * Disable PEC mode for an account: restore the INBOX label on its receipt threads,
 * clear its receipt flags, and remove the global "Ricevute" folder if no other
 * account still has PEC mode enabled.
 */
export async function disablePec(accountId: string): Promise<void> {
  await setAccountPecEnabled(accountId, false);
  const db = await getDb();
  await db.execute(
    `INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id)
     SELECT DISTINCT account_id, thread_id, 'INBOX' FROM messages
     WHERE account_id = $1 AND is_pec_receipt = 1 AND is_trashed = 0`,
    [accountId],
  );
  await db.execute(
    "UPDATE messages SET is_pec_receipt = 0 WHERE account_id = $1 AND is_pec_receipt = 1",
    [accountId],
  );
  const rows = await db.select<{ remaining: number }[]>(
    "SELECT COUNT(*) AS remaining FROM accounts WHERE pec_enabled = 1",
  );
  if ((rows[0]?.remaining ?? 0) === 0) {
    await db.execute("DELETE FROM smart_folders WHERE id = $1", [RICEVUTE_FOLDER_ID]);
  }
}
