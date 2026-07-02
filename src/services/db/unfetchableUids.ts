import { getDb } from "./connection";

/**
 * Skip-list for UIDs the self-healing reconcile must stop re-fetching, with a
 * `reason` per entry:
 *
 * - `'error'` — the server lists the UID but repeatedly refuses to serve its
 *   body (e.g. DavMail body stalls). Skipped after a configurable number of
 *   failed attempts, and surfaced to the user (see
 *   getUnfetchableCountForAccount) so the incompleteness is never silent.
 * - `'duplicate'` — the server serves the message fine, but its RFC Message-ID
 *   already exists in another folder so the store layer deliberately dedups it
 *   (commands.rs imap_fetch_and_store, Filter 2). Skipped immediately so the
 *   reconcile stops re-downloading the full body every cycle, but NOT counted
 *   as unfetchable — nothing is missing from the user's mailbox.
 */

/** UIDs in a folder the reconcile must skip: fetch failures past the retry cap, plus known cross-folder duplicates. */
export async function getSkippedUidsForFolder(
  accountId: string,
  folderPath: string,
  maxAttempts: number,
): Promise<Set<number>> {
  const db = await getDb();
  const rows = await db.select<{ uid: number }[]>(
    `SELECT uid FROM imap_unfetchable_uids
     WHERE account_id = $1 AND folder_path = $2
       AND (attempts >= $3 OR reason = 'duplicate')`,
    [accountId, folderPath, maxAttempts],
  );
  return new Set(rows.map((r) => r.uid));
}

/** Record one failed fetch attempt for each UID (increments the counter). */
export async function recordUnfetchableAttempts(
  accountId: string,
  folderPath: string,
  uids: number[],
): Promise<void> {
  if (uids.length === 0) return;
  const db = await getDb();
  for (const uid of uids) {
    await db.execute(
      `INSERT INTO imap_unfetchable_uids (account_id, folder_path, uid, attempts, first_seen_at, last_attempt_at)
       VALUES ($1, $2, $3, 1, unixepoch(), unixepoch())
       ON CONFLICT(account_id, folder_path, uid)
       DO UPDATE SET attempts = attempts + 1, last_attempt_at = unixepoch()`,
      [accountId, folderPath, uid],
    );
  }
}

/**
 * Mark UIDs as cross-folder duplicates: served by the server but deliberately
 * not stored (their RFC Message-ID already exists in another folder). Upgrades
 * any prior 'error' entry — a served message is by definition not unfetchable.
 */
export async function recordDuplicateUids(
  accountId: string,
  folderPath: string,
  uids: number[],
): Promise<void> {
  if (uids.length === 0) return;
  const db = await getDb();
  for (const uid of uids) {
    await db.execute(
      `INSERT INTO imap_unfetchable_uids (account_id, folder_path, uid, attempts, first_seen_at, last_attempt_at, reason)
       VALUES ($1, $2, $3, 1, unixepoch(), unixepoch(), 'duplicate')
       ON CONFLICT(account_id, folder_path, uid)
       DO UPDATE SET reason = 'duplicate', last_attempt_at = unixepoch()`,
      [accountId, folderPath, uid],
    );
  }
}

/** Clear entries for UIDs that were successfully fetched after all (self-clearing). */
export async function clearUnfetchableUids(
  accountId: string,
  folderPath: string,
  uids: number[],
): Promise<void> {
  if (uids.length === 0) return;
  const db = await getDb();
  const placeholders = uids.map((_, i) => `$${i + 3}`).join(", ");
  await db.execute(
    `DELETE FROM imap_unfetchable_uids
     WHERE account_id = $1 AND folder_path = $2 AND uid IN (${placeholders})`,
    [accountId, folderPath, ...uids],
  );
}

/**
 * How many messages are permanently skipped because the server refuses to
 * serve them (reached the retry cap) — surfaced in the UI so the
 * incompleteness is never silent. Cross-folder duplicates are excluded: they
 * are skipped as an optimization, not missing from the mailbox.
 */
export async function getUnfetchableCountForAccount(
  accountId: string,
  maxAttempts: number,
): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ n: number }[]>(
    `SELECT COUNT(*) AS n FROM imap_unfetchable_uids
     WHERE account_id = $1 AND attempts >= $2 AND reason != 'duplicate'`,
    [accountId, maxAttempts],
  );
  return rows[0]?.n ?? 0;
}
