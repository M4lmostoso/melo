import { getDb } from "../db/connection";
import { getSetting, setSetting } from "../db/settings";
import { getAllAccounts, type DbAccount } from "../db/accounts";
import { buildImapConfig } from "../imap/imapConfigBuilder";
import { ensureFreshToken } from "../oauth/oauthTokenManager";
import { imapFetchListHeaders } from "../imap/tauriCommands";
import { logToFile } from "@/utils/fileLog";

/**
 * Recover List-Unsubscribe headers for IMAP messages synced before the Rust
 * parser persisted them.
 *
 * `mail-parser` classifies List-Unsubscribe as an address header, so
 * `extract_raw_header`'s predecessor stored NULL on every IMAP message — the
 * unsubscribe button, the message banner, the `u` shortcut and
 * Settings → People → Subscriptions are all driven off that column, so they
 * were dead on every non-Gmail account. New mail is fixed at parse time; this
 * fills in what is already cached WITHOUT re-downloading bodies
 * (`BODY.PEEK[HEADER.FIELDS (...)]`, a few hundred bytes per message).
 */

/** Messages per `UID FETCH` when only the two List-* fields are requested. */
const UID_BATCH = 200;
/** Smaller batches in full-header mode: ~12 KB per message instead of ~300 B. */
const UID_BATCH_WHOLE_HEADER = 25;
/** UIDs used to probe whether the expensive mode is worth it. */
const PROBE_UIDS = 25;
/**
 * Throughput floor for the full-header mode. DavMail serves a header block per
 * ~2.4s (measured over 40 messages of a real mailbox), which would turn a
 * backfill into an hour of background fetching for a work inbox that has
 * essentially no newsletters — not worth it, so a server that slow is left to
 * fix itself as new mail arrives.
 */
const WHOLE_HEADER_MAX_MS_PER_MESSAGE = 1000;
/** Per-account ceiling for one pass, so a huge mailbox cannot hog the network. */
const MAX_MESSAGES_PER_ACCOUNT = 4000;
/** Tighter ceiling once the expensive full-header mode is in play. */
const MAX_MESSAGES_WHOLE_HEADER = 600;
/** Skip anything older than this — nobody unsubscribes from a 2-year-old list. */
const MAX_AGE_DAYS = 400;

const DONE_KEY_PREFIX = "unsubscribe_backfill_done_";

interface PendingRow {
  id: string;
  imap_uid: number;
  imap_folder: string;
}

/**
 * Candidate messages: IMAP-coordinate rows with no List-Unsubscribe value yet.
 *
 * `list_unsubscribe` is NULL both for "never looked" and for "looked, not a
 * newsletter", which is why the pass is bounded and runs once per account
 * (see DONE_KEY_PREFIX) instead of retrying forever.
 */
async function getPendingMessages(
  accountId: string,
  limit: number,
): Promise<PendingRow[]> {
  const db = await getDb();
  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  return db.select<PendingRow[]>(
    `SELECT id, imap_uid, imap_folder
       FROM messages
      WHERE account_id = $1
        AND imap_uid IS NOT NULL
        AND imap_folder IS NOT NULL
        AND (list_unsubscribe IS NULL OR list_unsubscribe = '')
        AND date >= $2
      ORDER BY date DESC
      LIMIT $3`,
    [accountId, cutoff, limit],
  );
}

function groupByFolder(rows: PendingRow[]): Map<string, PendingRow[]> {
  const byFolder = new Map<string, PendingRow[]>();
  for (const row of rows) {
    const list = byFolder.get(row.imap_folder);
    if (list) list.push(row);
    else byFolder.set(row.imap_folder, [row]);
  }
  return byFolder;
}

/**
 * Persist the recovered headers.
 *
 * Matched on (imap_uid, imap_folder) rather than the row id: a DavMail UID
 * renumber can leave the id stale while the coordinates stay authoritative.
 */
async function storeHeaders(
  accountId: string,
  folder: string,
  headers: { uid: number; list_unsubscribe: string | null; list_unsubscribe_post: string | null }[],
): Promise<number> {
  const db = await getDb();
  let written = 0;
  for (const h of headers) {
    if (!h.list_unsubscribe) continue;
    const res = await db.execute(
      `UPDATE messages
          SET list_unsubscribe = $1, list_unsubscribe_post = $2
        WHERE account_id = $3 AND imap_folder = $4 AND imap_uid = $5`,
      [h.list_unsubscribe, h.list_unsubscribe_post, accountId, folder, h.uid],
    );
    written += res.rowsAffected;
  }
  return written;
}

async function buildConfig(account: DbAccount) {
  if (account.auth_method === "oauth2") {
    const token = await ensureFreshToken(account);
    return buildImapConfig(account, token);
  }
  return buildImapConfig(account);
}

/**
 * One account's pass. Returns the number of messages that gained a header.
 *
 * Two modes, because `HEADER.FIELDS (LIST-UNSUBSCRIBE …)` is not universally
 * served: DavMail answers it with an empty literal (it maps HEADER.FIELDS onto
 * a fixed set of EWS properties that excludes List-Unsubscribe — `SUBJECT`
 * comes back from the same server, this header does not). The first batch is a
 * probe: if the cheap mode finds nothing, the SAME batch is retried asking for
 * the whole header block, and only a hit there switches the account over — a
 * mailbox that genuinely has no newsletters must not pay full-header prices.
 *
 * A server that answers a section fetch with the whole message makes the
 * backfill more expensive than a resync, so the Rust side rejects and we
 * abandon that account permanently rather than retrying at every startup.
 */
async function backfillAccount(account: DbAccount): Promise<number> {
  const config = await buildConfig(account);
  let wholeHeader = false;
  let probed = false;
  let written = 0;
  let processed = 0;

  const pending = await getPendingMessages(account.id, MAX_MESSAGES_PER_ACCOUNT);
  if (pending.length === 0) return 0;

  for (const [folder, rows] of groupByFolder(pending)) {
    for (let i = 0; i < rows.length; ) {
      const batchSize = wholeHeader ? UID_BATCH_WHOLE_HEADER : UID_BATCH;
      const batch = rows.slice(i, i + batchSize);
      const uidRange = batch.map((r) => r.imap_uid).join(",");
      try {
        const headers = await imapFetchListHeaders(config, folder, uidRange, wholeHeader);
        const found = headers.filter((h) => h.list_unsubscribe).length;

        // Probe: a whole batch with nothing in it may mean the server strips
        // the field rather than that the mail is header-free. Retry a slice of
        // it asking for the full header block, and adopt that mode only if it
        // both finds something and is fast enough to be worth it.
        if (!probed && !wholeHeader && found === 0 && headers.length >= 10) {
          probed = true;
          const probeUids = batch.slice(0, PROBE_UIDS);
          const probeRange = probeUids.map((r) => r.imap_uid).join(",");
          const startedAt = Date.now();
          const retry = await imapFetchListHeaders(config, folder, probeRange, true);
          const msPerMessage = (Date.now() - startedAt) / Math.max(probeUids.length, 1);

          if (retry.some((h) => h.list_unsubscribe)) {
            if (msPerMessage > WHOLE_HEADER_MAX_MS_PER_MESSAGE) {
              logToFile(
                "info",
                `[unsubscribe] ${account.email}: full-header fallback needed but too slow ` +
                  `(${Math.round(msPerMessage)}ms/message) — leaving the backlog to new mail`,
              );
            } else {
              logToFile(
                "info",
                `[unsubscribe] ${account.email}: server drops List-Unsubscribe from HEADER.FIELDS — falling back to full headers`,
              );
              wholeHeader = true;
            }
            written += await storeHeaders(account.id, folder, retry);
            i += probeUids.length;
            processed += probeUids.length;
            continue;
          }
        }
        probed = true;

        written += await storeHeaders(account.id, folder, headers);
      } catch (err) {
        const msg = String(err);
        if (msg.includes("ignored HEADER.FIELDS")) {
          logToFile(
            "warn",
            `[unsubscribe] backfill aborted for ${account.email}: server serves whole messages for header fetches`,
          );
          throw err;
        }
        // A single bad batch (one poison UID, a dropped connection) must not
        // stop the rest of the mailbox.
        console.warn(
          `[unsubscribe] header fetch failed for ${folder} UIDs ${uidRange.slice(0, 60)}…:`,
          err,
        );
      }
      i += batch.length;
      processed += batch.length;

      // Full-header mode moves ~40x more data per message, so it stops well
      // short of the cheap mode's ceiling. Whatever is left is picked up as
      // new mail arrives, which is parsed correctly at sync time.
      if (wholeHeader && processed >= MAX_MESSAGES_WHOLE_HEADER) break;
    }

    if (wholeHeader && processed >= MAX_MESSAGES_WHOLE_HEADER) break;
  }

  return written;
}

/**
 * Backfill every IMAP account that has not been done yet.
 *
 * Main window only (it holds the sync), fire-and-forget, and each account is
 * marked done even when it yielded nothing — the pass is a one-off repair, not
 * a recurring scan.
 */
export async function backfillUnsubscribeHeaders(): Promise<void> {
  let accounts: DbAccount[];
  try {
    accounts = await getAllAccounts();
  } catch (err) {
    console.error("[unsubscribe] backfill could not load accounts:", err);
    return;
  }

  for (const account of accounts) {
    if (!account.imap_host) continue; // Gmail API accounts already have the header

    const doneKey = `${DONE_KEY_PREFIX}${account.id}`;
    if (await getSetting(doneKey)) continue;

    try {
      const written = await backfillAccount(account);
      await setSetting(doneKey, String(Date.now()));
      if (written > 0) {
        logToFile(
          "info",
          `[unsubscribe] backfilled List-Unsubscribe on ${written} message(s) for ${account.email}`,
        );
      }
    } catch (err) {
      const msg = String(err);
      if (msg.includes("ignored HEADER.FIELDS")) {
        // Permanent server limitation: never try again for this account.
        await setSetting(doneKey, `unsupported:${Date.now()}`);
        continue;
      }
      // Transient (offline, auth): leave unclaimed so the next startup retries.
      console.warn(`[unsubscribe] backfill failed for ${account.email}:`, err);
    }
  }
}
