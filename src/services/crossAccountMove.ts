import { getAccount } from "./db/accounts";
import { getMessagesForThread } from "./db/messages";
import { getDb } from "./db/connection";
import { buildImapConfig } from "./imap/imapConfigBuilder";
import { imapFetchRawMessage, imapAppendMessage, imapDeleteMessages } from "./imap/tauriCommands";
import { getGmailClient } from "./gmail/tokenManager";

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
 * Move all messages of the given threads from sourceAccountId to targetAccountId.
 *
 * Flow per message:
 *   1. Fetch raw RFC 2822 bytes from source
 *   2. INSERT / APPEND into target account's target folder
 *   3. DELETE from source
 *
 * Supports IMAP→IMAP, Gmail→Gmail, and mixed combinations.
 * The local DB is cleaned up by the next background sync on both accounts.
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
      } else {
        if (!targetGmail) continue;
        await targetGmail.insertMessage(rawBase64url, targetGmailLabels);
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
}
