import { getDb } from "./connection";

/**
 * Skip-list for UIDs the server lists but repeatedly refuses to serve the body
 * for (e.g. DavMail body stalls, or messages behind an unstable-UID churn that
 * never resolve to a new stored message). After a configurable number of failed
 * attempts a UID is considered permanently unfetchable and excluded from the
 * self-healing reconcile, so the sync stops re-grinding it forever — while
 * staying visible to the user (see getUnfetchableCountForAccount).
 */

/** UIDs in a folder that have reached the retry cap (skip these when reconciling). */
export async function getSkippedUidsForFolder(
  accountId: string,
  folderPath: string,
  maxAttempts: number,
): Promise<Set<number>> {
  const db = await getDb();
  const rows = await db.select<{ uid: number }[]>(
    `SELECT uid FROM imap_unfetchable_uids
     WHERE account_id = $1 AND folder_path = $2 AND attempts >= $3`,
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
 * How many messages are permanently skipped (reached the retry cap) for an
 * account — surfaced in the UI so the incompleteness is never silent.
 */
export async function getUnfetchableCountForAccount(
  accountId: string,
  maxAttempts: number,
): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ n: number }[]>(
    `SELECT COUNT(*) AS n FROM imap_unfetchable_uids
     WHERE account_id = $1 AND attempts >= $2`,
    [accountId, maxAttempts],
  );
  return rows[0]?.n ?? 0;
}
