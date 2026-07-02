import { getDb } from "./connection";
import { getSetting } from "./settings";

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

/** Default retry cap before a persistently-unfetchable UID is skip-listed. */
const DEFAULT_UNFETCHABLE_MAX_RETRIES = 3;

/** Retry cap from settings (`imap_unfetchable_max_retries`), defaulting to 3. */
export async function getUnfetchableMaxRetries(): Promise<number> {
  const raw = await getSetting("imap_unfetchable_max_retries");
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_UNFETCHABLE_MAX_RETRIES;
}

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
 * are skipped as an optimization, not missing from the mailbox. Entries the
 * user explicitly acknowledged (ignored = 1) are excluded too — they remain
 * visible and restorable in Settings.
 */
export async function getUnfetchableCountForAccount(
  accountId: string,
  maxAttempts: number,
): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ n: number }[]>(
    `SELECT COUNT(*) AS n FROM imap_unfetchable_uids
     WHERE account_id = $1 AND attempts >= $2 AND reason != 'duplicate' AND ignored = 0`,
    [accountId, maxAttempts],
  );
  return rows[0]?.n ?? 0;
}

/** One genuinely-unfetchable message, with local-DB context to help the user locate it on the server. */
export interface UnfetchableMessageEntry {
  accountId: string;
  accountEmail: string;
  folderPath: string;
  uid: number;
  attempts: number;
  firstSeenAt: number;
  lastAttemptAt: number;
  ignored: boolean;
  /** Nearest locally-stored message before the gap (by UID in the same folder), if any. */
  prevSubject: string | null;
  prevDate: number | null;
  /** Nearest locally-stored message after the gap (by UID in the same folder), if any. */
  nextSubject: string | null;
  nextDate: number | null;
}

/**
 * Detailed list of genuinely-unfetchable messages (reason = 'error', past the
 * retry cap), including ignored ones. Each entry is enriched with the nearest
 * locally-stored neighbours in the same folder so the user can identify the
 * missing message by date/subject in the provider's webmail.
 */
export async function listUnfetchableMessages(
  maxAttempts: number,
  accountId?: string,
): Promise<UnfetchableMessageEntry[]> {
  const db = await getDb();
  const rows = await db.select<
    {
      account_id: string;
      email: string;
      folder_path: string;
      uid: number;
      attempts: number;
      first_seen_at: number;
      last_attempt_at: number;
      ignored: number;
    }[]
  >(
    `SELECT u.account_id, a.email, u.folder_path, u.uid, u.attempts, u.first_seen_at, u.last_attempt_at, u.ignored
     FROM imap_unfetchable_uids u
     JOIN accounts a ON a.id = u.account_id
     WHERE u.reason != 'duplicate' AND u.attempts >= $1
       ${accountId ? "AND u.account_id = $2" : ""}
     ORDER BY a.email, u.folder_path, u.uid`,
    accountId ? [maxAttempts, accountId] : [maxAttempts],
  );

  const entries: UnfetchableMessageEntry[] = [];
  for (const r of rows) {
    const [prev] = await db.select<{ subject: string | null; date: number }[]>(
      `SELECT subject, date FROM messages
       WHERE account_id = $1 AND imap_folder = $2 AND imap_uid IS NOT NULL AND imap_uid < $3
       ORDER BY imap_uid DESC LIMIT 1`,
      [r.account_id, r.folder_path, r.uid],
    );
    const [next] = await db.select<{ subject: string | null; date: number }[]>(
      `SELECT subject, date FROM messages
       WHERE account_id = $1 AND imap_folder = $2 AND imap_uid IS NOT NULL AND imap_uid > $3
       ORDER BY imap_uid ASC LIMIT 1`,
      [r.account_id, r.folder_path, r.uid],
    );
    entries.push({
      accountId: r.account_id,
      accountEmail: r.email,
      folderPath: r.folder_path,
      uid: r.uid,
      attempts: r.attempts,
      firstSeenAt: r.first_seen_at,
      lastAttemptAt: r.last_attempt_at,
      ignored: r.ignored === 1,
      prevSubject: prev?.subject ?? null,
      prevDate: prev?.date ?? null,
      nextSubject: next?.subject ?? null,
      nextDate: next?.date ?? null,
    });
  }
  return entries;
}

/** Set or clear the user's "ignore this warning" acknowledgement for one entry. */
export async function setUnfetchableIgnored(
  accountId: string,
  folderPath: string,
  uid: number,
  ignored: boolean,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE imap_unfetchable_uids SET ignored = $4
     WHERE account_id = $1 AND folder_path = $2 AND uid = $3`,
    [accountId, folderPath, uid, ignored ? 1 : 0],
  );
}
