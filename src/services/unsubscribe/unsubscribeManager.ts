import { getDb } from "../db/connection";
import { getSetting } from "../db/settings";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fetch } from "@tauri-apps/plugin-http";
import { getCurrentUnixTimestamp } from "@/utils/timestamp";
import { normalizeEmail } from "@/utils/emailUtils";

export interface ParsedUnsubscribe {
  httpUrl: string | null;
  mailtoAddress: string | null;
  hasOneClick: boolean;
}

export interface SubscriptionEntry {
  from_address: string;
  from_name: string | null;
  latest_unsubscribe_header: string;
  latest_unsubscribe_post: string | null;
  message_count: number;
  latest_date: number;
  status: string | null;
}

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
 * Execute unsubscribe using the best available method:
 * 1. RFC 8058 one-click POST (no browser needed)
 * 2. mailto via Gmail API
 * 3. Fallback: open URL in browser
 */
export async function executeUnsubscribe(
  accountId: string,
  threadId: string,
  fromAddress: string,
  fromName: string | null,
  listUnsubscribe: string,
  listUnsubscribePost: string | null,
): Promise<{ method: string; success: boolean }> {
  const parsed = parseUnsubscribeHeaders(listUnsubscribe, listUnsubscribePost);

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

  // Record the action
  await recordUnsubscribeAction(
    accountId,
    threadId,
    fromAddress,
    fromName,
    method,
    parsed.httpUrl ?? parsed.mailtoAddress ?? listUnsubscribe,
    success ? "unsubscribed" : "failed",
  );

  if (success) {
    // Best-effort: a failed cleanup must not turn a completed unsubscribe into
    // a reported failure.
    await archiveAfterUnsubscribe(accountId, fromAddress).catch((err) =>
      console.error("[unsubscribe] post-unsubscribe archive failed:", err),
    );
  }

  return { method, success };
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

  const db = await getDb();
  const rows = await db.select<{ thread_id: string; message_ids: string }[]>(
    `SELECT m.thread_id, GROUP_CONCAT(m.id) as message_ids
       FROM messages m
       JOIN threads t ON t.id = m.thread_id AND t.account_id = m.account_id
      WHERE m.account_id = $1
        AND LOWER(m.from_address) = $2
        AND COALESCE(m.is_trashed, 0) = 0
        AND COALESCE(m.is_draft, 0) = 0
        AND EXISTS (
          SELECT 1 FROM thread_labels tl
           WHERE tl.thread_id = t.id AND tl.account_id = t.account_id
             AND tl.label_id = 'INBOX'
        )
      GROUP BY m.thread_id`,
    [accountId, normalizeEmail(fromAddress)],
  );

  const { archiveThread } = await import("../emailActions");
  let archived = 0;
  for (const row of rows) {
    const messageIds = (row.message_ids ?? "").split(",").filter(Boolean);
    if (messageIds.length === 0) continue;
    try {
      await archiveThread(accountId, row.thread_id, messageIds);
      archived++;
    } catch (err) {
      console.error(`[unsubscribe] archive of thread ${row.thread_id} failed:`, err);
    }
  }

  if (archived > 0) {
    console.log(
      `[unsubscribe] archived ${archived} thread(s) from ${fromAddress} after unsubscribe`,
    );
  }
  return archived;
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
 * Get all detectable newsletter/promo subscriptions for an account.
 */
export async function getSubscriptions(accountId: string): Promise<SubscriptionEntry[]> {
  const db = await getDb();
  return db.select<SubscriptionEntry[]>(
    `SELECT
       m.from_address,
       MAX(m.from_name) as from_name,
       MAX(m.list_unsubscribe) as latest_unsubscribe_header,
       MAX(m.list_unsubscribe_post) as latest_unsubscribe_post,
       COUNT(*) as message_count,
       MAX(m.date) as latest_date,
       ua.status
     FROM messages m
     LEFT JOIN unsubscribe_actions ua ON ua.account_id = m.account_id AND ua.from_address = LOWER(m.from_address)
     WHERE m.account_id = $1 AND m.list_unsubscribe IS NOT NULL
     GROUP BY LOWER(m.from_address)
     ORDER BY MAX(m.date) DESC`,
    [accountId],
  );
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
