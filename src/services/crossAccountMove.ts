import { getAccount } from "./db/accounts";
import { getMessagesForThread } from "./db/messages";
import { getDb } from "./db/connection";
import { addPendingLabelAssignments } from "./db/pendingLabelAssignments";
import { buildImapConfig } from "./imap/imapConfigBuilder";
import { imapFetchRawMessage, imapAppendMessage, imapDeleteMessages } from "./imap/tauriCommands";
import { getGmailClient } from "./gmail/tokenManager";
import { triggerSync } from "./gmail/syncManager";

// Maps sidebar folder keys → Gmail label IDs to apply on insert
const FOLDER_KEY_TO_GMAIL: Record<string, string[]> = {
  inbox:   ["INBOX"],
  starred: ["STARRED", "INBOX"],
  sent:    ["SENT"],
  drafts:  ["DRAFT"],
  trash:   ["TRASH"],
  spam:    ["SPAM"],
  snoozed: ["SNOOZED"],
  all:     ["INBOX"],
};

// Maps sidebar folder keys → standard IMAP folder name (RFC 6154 / common conventions)
const FOLDER_KEY_TO_IMAP: Record<string, string> = {
  inbox:   "INBOX",
  starred: "INBOX",
  sent:    "Sent",
  drafts:  "Drafts",
  trash:   "Trash",
  spam:    "Junk",
  snoozed: "INBOX",
  all:     "INBOX",
};

/**
 * Resolve which of the source thread's user (custom) labels also exist by name
 * in the target account, returning the matching target `user_labels.id`s.
 *
 * Used to preserve custom labels across accounts: a label is carried over only
 * when an identically-named label already exists in the target account;
 * otherwise it is dropped (we never auto-create labels in the target).
 *
 * Works for both Gmail and IMAP targets — both keep their custom labels in
 * `user_labels` (Gmail mirrors its server labels there; IMAP stores local-only
 * labels). How the resolved IDs are *applied* differs by provider: Gmail sets
 * them server-side via the API on insert, IMAP records a deferred assignment
 * applied once the moved message is synced.
 */
async function resolveCarryOverTargetLabelIds(
  sourceAccountId: string,
  threadId: string,
  targetAccountId: string,
): Promise<string[]> {
  const db = await getDb();

  // Names of the source thread's user-type labels
  const sourceLabels = await db.select<{ name: string }[]>(
    `SELECT ul.name
       FROM thread_labels tl
       INNER JOIN user_labels ul ON ul.id = tl.label_id AND ul.account_id = tl.account_id
       WHERE tl.account_id = $1 AND tl.thread_id = $2`,
    [sourceAccountId, threadId],
  );
  if (sourceLabels.length === 0) return [];

  // Target account's user labels, keyed by name
  const targetLabels = await db.select<{ id: string; name: string }[]>(
    "SELECT id, name FROM user_labels WHERE account_id = $1",
    [targetAccountId],
  );
  const targetByName = new Map(targetLabels.map((l) => [l.name, l.id]));

  const ids = new Set<string>();
  for (const { name } of sourceLabels) {
    const id = targetByName.get(name);
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * Move all messages of the given threads from sourceAccountId to targetAccountId.
 *
 * Flow per message:
 *   1. Fetch raw RFC 2822 bytes from source
 *   2. INSERT / APPEND into target account's target folder
 *   3. DELETE from source
 *
 * Supports IMAP→IMAP, Gmail→Gmail, and mixed combinations.
 * Once all messages are moved, an immediate sync is triggered for both accounts
 * (rather than waiting for the next 60s background tick) so the moved messages
 * land, get threaded, and settle into their final grouped state in one pass
 * instead of flickering in as separate unread messages across sync cycles.
 */
export async function crossAccountMoveThreads(
  sourceAccountId: string,
  targetAccountId: string,
  threadIds: string[],
  targetFolderKey = "inbox",
): Promise<void> {
  const [sourceAccount, targetAccount] = await Promise.all([
    getAccount(sourceAccountId),
    getAccount(targetAccountId),
  ]);
  if (!sourceAccount || !targetAccount) throw new Error("Account not found");

  const sourceIsImap = sourceAccount.provider === "imap" || sourceAccount.provider === "icloud";
  const targetIsImap = targetAccount.provider === "imap" || targetAccount.provider === "icloud";

  const sourceConfig = sourceIsImap ? buildImapConfig(sourceAccount) : null;
  const targetConfig = targetIsImap ? buildImapConfig(targetAccount) : null;
  const sourceGmail = !sourceIsImap ? await getGmailClient(sourceAccountId) : null;
  const targetGmail = !targetIsImap ? await getGmailClient(targetAccountId) : null;

  const targetImapFolder = FOLDER_KEY_TO_IMAP[targetFolderKey] ?? "INBOX";
  const targetGmailLabels = FOLDER_KEY_TO_GMAIL[targetFolderKey] ?? ["INBOX"];

  for (const threadId of threadIds) {
    const messages = await getMessagesForThread(sourceAccountId, threadId, true);

    // Custom (user) labels that also exist by name in the target account are
    // preserved on the moved thread; labels with no match are dropped. Gmail
    // applies them server-side on insert; IMAP records a deferred assignment
    // (keyed by the message's RFC Message-ID) applied once the move is synced.
    const carryOverLabelIds = await resolveCarryOverTargetLabelIds(
      sourceAccountId, threadId, targetAccountId,
    );
    const insertGmailLabels = [...new Set([...targetGmailLabels, ...carryOverLabelIds])];

    for (const msg of messages) {
      let rawBase64url: string;

      // ── 1. Fetch raw from source ──────────────────────────────────────────
      if (sourceIsImap) {
        if (!sourceConfig || msg.imap_uid == null || !msg.imap_folder) continue;
        const rawString = await imapFetchRawMessage(sourceConfig, msg.imap_folder, msg.imap_uid);
        // Encode as base64url safely handling non-ASCII bytes
        const bytes = new TextEncoder().encode(rawString);
        let binary = "";
        bytes.forEach((b) => { binary += String.fromCharCode(b); });
        rawBase64url = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      } else {
        if (!sourceGmail) continue;
        const raw = await sourceGmail.getMessage(msg.id, "raw") as { raw?: string };
        if (!raw.raw) continue;
        rawBase64url = raw.raw;
      }

      // ── 2. Insert into target ─────────────────────────────────────────────
      if (targetIsImap) {
        if (!targetConfig) continue;
        await imapAppendMessage(targetConfig, targetImapFolder, rawBase64url);
        // IMAP has no server-side labels — defer the carry-over until the
        // appended message is synced and gets a local thread_id.
        if (carryOverLabelIds.length > 0 && msg.message_id_header) {
          await addPendingLabelAssignments(
            targetAccountId, msg.message_id_header, carryOverLabelIds,
          );
        }
      } else {
        if (!targetGmail) continue;
        await targetGmail.insertMessage(rawBase64url, insertGmailLabels);
      }

      // ── 3. Delete from source ─────────────────────────────────────────────
      if (sourceIsImap) {
        if (!sourceConfig || msg.imap_uid == null || !msg.imap_folder) continue;
        await imapDeleteMessages(sourceConfig, msg.imap_folder, [msg.imap_uid]);
      } else {
        if (!sourceGmail) continue;
        await sourceGmail.trashMessage(msg.id);
      }
    }

    // Mark the thread as deleted locally so it disappears from the current view
    const db = await getDb();
    await db.execute(
      "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2",
      [sourceAccountId, threadId],
    );
  }

  // Kick off an immediate sync of both accounts in the background (not awaited,
  // so the UI can remove the source thread right away) so the moved messages
  // are fetched, threaded, and grouped into their final thread in one coalesced
  // pass — instead of straddling one or more separate 60s background ticks and
  // briefly appearing as loose unread messages before compacting.
  triggerSync([sourceAccountId, targetAccountId]).catch((err) => {
    console.error("Post-move sync failed:", err);
  });
}
