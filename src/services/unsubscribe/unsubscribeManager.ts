import { getDb } from "../db/connection";
import { getSetting } from "../db/settings";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fetch } from "@tauri-apps/plugin-http";
import { getCurrentUnixTimestamp } from "@/utils/timestamp";
import { normalizeEmail } from "@/utils/emailUtils";
import { findUnsubscribeLinkInHtml } from "./unsubscribeLinks";

export interface ParsedUnsubscribe {
  httpUrl: string | null;
  mailtoAddress: string | null;
  hasOneClick: boolean;
}

export interface SubscriptionEntry {
  from_address: string;
  from_name: string | null;
  /** NULL for senders detected only by category — their opt-out link lives in the body. */
  latest_unsubscribe_header: string | null;
  latest_unsubscribe_post: string | null;
  message_count: number;
  count_30d: number;
  count_90d: number;
  read_count: number;
  latest_date: number;
  status: string | null;
}

/** What happens to a sender's existing mail once the opt-out went through. */
export type SenderCleanup = "archive" | "trash";

/**
 * Parse List-Unsubscribe and List-Unsubscribe-Post headers into actionable data.
 */
export function parseUnsubscribeHeaders(
  listUnsubscribe: string,
  listUnsubscribePost: string | null,
): ParsedUnsubscribe {
  const httpMatch = listUnsubscribe.match(/<(https?:\/\/[^>]+)>/);
  const mailtoMatch = listUnsubscribe.match(/<mailto:([^>]+)>/);
  const hasOneClick = !!listUnsubscribePost?.toLowerCase().includes("list-unsubscribe=one-click");

  return {
    httpUrl: httpMatch?.[1] ?? null,
    mailtoAddress: mailtoMatch?.[1] ?? null,
    hasOneClick,
  };
}

/**
 * Look through the sender's most recent cached bodies for an opt-out link.
 * Bodies not yet downloaded are simply skipped — no network here. Spam is
 * never scanned (see `findThreadUnsubscribeTarget`).
 */
export async function findBodyUnsubscribeLink(
  accountId: string,
  fromAddress: string,
): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ body_html: string }[]>(
    `SELECT body_html FROM messages
      WHERE account_id = $1 AND LOWER(from_address) = $2
        AND body_html IS NOT NULL AND COALESCE(is_draft, 0) = 0
        AND NOT EXISTS (
          SELECT 1 FROM thread_labels tl
           WHERE tl.account_id = messages.account_id AND tl.thread_id = messages.thread_id
             AND tl.label_id = 'SPAM'
        )
      ORDER BY date DESC
      LIMIT 5`,
    [accountId, normalizeEmail(fromAddress)],
  );
  for (const row of rows) {
    const link = findUnsubscribeLinkInHtml(row.body_html);
    if (link) return link;
  }
  return null;
}

/**
 * Execute unsubscribe using the best available method:
 * 1. RFC 8058 one-click POST (no browser needed)
 * 2. mailto via the account's provider
 * 3. Fallback: open the header URL in the browser
 * 4. No header at all: open the opt-out link found in the mail body
 *
 * `cleanup` overrides what happens to the sender's existing mail on success;
 * when omitted the `auto_archive_after_unsubscribe` setting decides.
 * `bodyLink` is an opt-out link the caller already found in the body (step 4);
 * without it the sender's recent cached bodies are searched.
 */
export async function executeUnsubscribe(
  accountId: string,
  threadId: string,
  fromAddress: string,
  fromName: string | null,
  listUnsubscribe: string | null,
  listUnsubscribePost: string | null,
  { cleanup, bodyLink: knownBodyLink }: { cleanup?: SenderCleanup | "none"; bodyLink?: string | null } = {},
): Promise<{ method: string; success: boolean; cleaned: number }> {
  const parsed = listUnsubscribe
    ? parseUnsubscribeHeaders(listUnsubscribe, listUnsubscribePost)
    : { httpUrl: null, mailtoAddress: null, hasOneClick: false };

  let method = "browser";
  let success = false;

  // Method 1: RFC 8058 one-click HTTP POST
  if (parsed.hasOneClick && parsed.httpUrl) {
    try {
      const response = await fetch(parsed.httpUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new TextEncoder().encode("List-Unsubscribe=One-Click"),
      });
      success = response.ok || response.status === 200 || response.status === 202;
      method = "http_post";
    } catch (err) {
      console.error("One-click unsubscribe failed, trying fallback:", err);
    }
  }

  // Method 2: mailto, sent through the account's own provider.
  // Must go through getEmailProvider — the Gmail client it used to call
  // directly exists only for gmail_api accounts, so on IMAP the mailto method
  // was skipped entirely and senders offering *only* a mailto could not be
  // unsubscribed from at all.
  if (!success && parsed.mailtoAddress) {
    try {
      const to = parsed.mailtoAddress.split("?")[0] ?? parsed.mailtoAddress;
      // Extract subject from mailto params if present
      const subjectMatch = parsed.mailtoAddress.match(/subject=([^&]+)/i);
      const subject = subjectMatch ? decodeURIComponent(subjectMatch[1]!) : "unsubscribe";

      const { getAccount } = await import("../db/accounts");
      const account = await getAccount(accountId);
      const { buildRawEmail } = await import("../../utils/emailBuilder");
      const raw = buildRawEmail({
        from: account?.email ?? "",
        to: [to],
        subject,
        htmlBody: "unsubscribe",
      });
      const { getEmailProvider } = await import("../email/providerFactory");
      const provider = await getEmailProvider(accountId);
      await provider.sendMessage(raw);
      method = "mailto";
      success = true;
    } catch (err) {
      console.error("Mailto unsubscribe failed, trying fallback:", err);
    }
  }

  // Method 3: open in browser
  if (!success && parsed.httpUrl) {
    try {
      await openUrl(parsed.httpUrl);
      method = "browser";
      success = true;
    } catch (err) {
      console.error("Browser unsubscribe failed:", err);
    }
  }

  // Method 4: no usable header — the opt-out link in the body
  let bodyLink: string | null = null;
  if (!success && !parsed.httpUrl && !parsed.mailtoAddress) {
    try {
      bodyLink = knownBodyLink ?? (await findBodyUnsubscribeLink(accountId, fromAddress));
      if (bodyLink) {
        await openUrl(bodyLink);
        method = "browser_body";
        success = true;
      }
    } catch (err) {
      console.error("Body-link unsubscribe failed:", err);
    }
  }

  // Record the action
  await recordUnsubscribeAction(
    accountId,
    threadId,
    fromAddress,
    fromName,
    method,
    parsed.httpUrl ?? parsed.mailtoAddress ?? bodyLink ?? listUnsubscribe ?? "",
    success ? "unsubscribed" : "failed",
  );

  let cleaned = 0;
  if (success && cleanup !== "none") {
    // Best-effort: a failed cleanup must not turn a completed unsubscribe into
    // a reported failure.
    cleaned = await (cleanup
      ? cleanupSenderMail(accountId, fromAddress, cleanup)
      : archiveAfterUnsubscribe(accountId, fromAddress)
    ).catch((err) => {
      console.error("[unsubscribe] post-unsubscribe cleanup failed:", err);
      return 0;
    });
  }

  return { method, success, cleaned };
}

/**
 * Archive the mail still sitting in the inbox from a sender just unsubscribed
 * from, when `auto_archive_after_unsubscribe` is on (it is by default).
 *
 * Unsubscribing stops *future* mail; without this the back catalogue stays in
 * the inbox and the feature feels like it did nothing. Archive, never trash:
 * senders put receipts and order confirmations on the same list.
 *
 * Goes through `archiveThread` so the change is optimistic, queued when
 * offline, and correct for both Gmail and IMAP.
 */
export async function archiveAfterUnsubscribe(
  accountId: string,
  fromAddress: string,
): Promise<number> {
  if ((await getSetting("auto_archive_after_unsubscribe")) !== "true") return 0;
  return cleanupSenderMail(accountId, fromAddress, "archive");
}

/**
 * Move a sender's existing mail out of the way, through `archiveThread` /
 * `trashThread` so the change is optimistic, queued when offline, and correct
 * for both Gmail and IMAP.
 *
 * - archive: threads of theirs still in the INBOX.
 * - trash: every non-trashed thread made up *only* of their mail — a thread
 *   where someone else (the user included) also wrote is left alone, so a
 *   reply to a newsletter never ends up in the Trash with it.
 */
export async function cleanupSenderMail(
  accountId: string,
  fromAddress: string,
  mode: SenderCleanup,
): Promise<number> {
  const db = await getDb();
  const sender = normalizeEmail(fromAddress);
  const scope =
    mode === "archive"
      ? `AND EXISTS (
          SELECT 1 FROM thread_labels tl
           WHERE tl.thread_id = m.thread_id AND tl.account_id = m.account_id
             AND tl.label_id = 'INBOX'
        )`
      : `AND NOT EXISTS (
          SELECT 1 FROM messages o
           WHERE o.account_id = m.account_id AND o.thread_id = m.thread_id
             AND COALESCE(o.is_draft, 0) = 0
             AND LOWER(COALESCE(o.from_address, '')) <> $2
        )`;
  const rows = await db.select<{ thread_id: string; message_ids: string }[]>(
    `SELECT m.thread_id, GROUP_CONCAT(m.id) as message_ids
       FROM messages m
       JOIN threads t ON t.id = m.thread_id AND t.account_id = m.account_id
      WHERE m.account_id = $1
        AND LOWER(m.from_address) = $2
        AND COALESCE(m.is_trashed, 0) = 0
        AND COALESCE(m.is_draft, 0) = 0
        ${scope}
      GROUP BY m.thread_id`,
    [accountId, sender],
  );

  const { archiveThread, trashThread } = await import("../emailActions");
  const act = mode === "archive" ? archiveThread : trashThread;
  let done = 0;
  for (const row of rows) {
    const messageIds = (row.message_ids ?? "").split(",").filter(Boolean);
    if (messageIds.length === 0) continue;
    try {
      await act(accountId, row.thread_id, messageIds);
      done++;
    } catch (err) {
      console.error(`[unsubscribe] ${mode} of thread ${row.thread_id} failed:`, err);
    }
  }

  if (done > 0) {
    console.log(`[unsubscribe] ${mode}d ${done} thread(s) from ${fromAddress}`);
  }
  return done;
}

async function recordUnsubscribeAction(
  accountId: string,
  threadId: string,
  fromAddress: string,
  fromName: string | null,
  method: string,
  url: string,
  status: string,
): Promise<void> {
  const db = await getDb();
  const id = crypto.randomUUID();
  const now = getCurrentUnixTimestamp();
  await db.execute(
    `INSERT INTO unsubscribe_actions (id, account_id, thread_id, from_address, from_name, method, unsubscribe_url, status, unsubscribed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT(account_id, from_address) DO UPDATE SET
       status = $8, unsubscribed_at = $9, method = $6, thread_id = $3`,
    [id, accountId, threadId, normalizeEmail(fromAddress), fromName, method, url, status, now],
  );
}

/**
 * Get all detectable newsletter/promo subscriptions for an account, one row per
 * sender with volume and open-rate stats.
 *
 * A sender qualifies through a List-Unsubscribe header OR through a thread
 * categorised Promotions/Newsletters — the latter covers senders whose opt-out
 * lives only in the body (`findBodyUnsubscribeLink`).
 */
export async function getSubscriptions(
  accountId: string,
  now: number = Date.now(),
): Promise<SubscriptionEntry[]> {
  const db = await getDb();
  const day = 86_400_000;
  return db.select<SubscriptionEntry[]>(
    `WITH sm AS (
       SELECT
         LOWER(m.from_address) AS addr,
         m.from_name, m.list_unsubscribe, m.list_unsubscribe_post, m.is_read,
         -- IMAP stores seconds, Gmail milliseconds (see utils/date.ts toMs)
         CASE WHEN m.date < 10000000000 THEN m.date * 1000 ELSE m.date END AS ms
       FROM messages m
       LEFT JOIN thread_categories tc
         ON tc.account_id = m.account_id AND tc.thread_id = m.thread_id
       WHERE m.account_id = $1
         AND m.from_address IS NOT NULL
         AND COALESCE(m.is_draft, 0) = 0
         AND (m.list_unsubscribe IS NOT NULL
              OR tc.category IN ('Promotions', 'Newsletters'))
     )
     SELECT
       sm.addr AS from_address,
       MAX(sm.from_name) AS from_name,
       MAX(sm.list_unsubscribe) AS latest_unsubscribe_header,
       MAX(sm.list_unsubscribe_post) AS latest_unsubscribe_post,
       COUNT(*) AS message_count,
       SUM(CASE WHEN sm.ms >= $2 THEN 1 ELSE 0 END) AS count_30d,
       SUM(CASE WHEN sm.ms >= $3 THEN 1 ELSE 0 END) AS count_90d,
       SUM(COALESCE(sm.is_read, 0)) AS read_count,
       MAX(sm.ms) AS latest_date,
       MAX(ua.status) AS status
     FROM sm
     LEFT JOIN unsubscribe_actions ua ON ua.account_id = $1 AND ua.from_address = sm.addr
     GROUP BY sm.addr
     ORDER BY MAX(sm.ms) DESC`,
    [accountId, now - 30 * day, now - 90 * day],
  );
}

/**
 * True when a sender looks like noise the user ignores: a steady stream of mail
 * and none of it opened.
 */
export function isUnsubscribeSuggested(sub: SubscriptionEntry): boolean {
  return sub.status !== "unsubscribed" && sub.message_count >= 5 && sub.read_count === 0;
}

/**
 * Get unsubscribe status for a specific sender.
 */
export async function getUnsubscribeStatus(
  accountId: string,
  fromAddress: string,
): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ status: string }[]>(
    "SELECT status FROM unsubscribe_actions WHERE account_id = $1 AND from_address = $2",
    [accountId, normalizeEmail(fromAddress)],
  );
  return rows[0]?.status ?? null;
}
