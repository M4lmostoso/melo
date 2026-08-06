import { getAccount } from "./db/accounts";
import { getMessagesForThread } from "./db/messages";
import { getDb } from "./db/connection";
import { addPendingLabelAssignments } from "./db/pendingLabelAssignments";
import { buildImapConfig } from "./imap/imapConfigBuilder";
import {
  imapFetchRawMessageBase64,
  imapAppendMessage,
  imapDeleteMessages,
  toImapInternalDate,
} from "./imap/tauriCommands";
import { findSpecialFolder } from "./imap/messageHelper";
import { getLabelFolderMapping } from "./db/folderLabelMappings";
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

// Maps sidebar folder keys → the target account's special-use attribute, with the
// RFC 6154 / conventional folder name as the fallback when the server advertises
// no such special-use folder. Resolving through special-use matters: servers name
// these folders anything (DavMail's "Sent Items", localized "Posta inviata", …),
// and a hardcoded "Sent" would make the APPEND fail or create a stray folder.
const FOLDER_KEY_TO_IMAP: Record<string, { specialUse: string | null; fallback: string }> = {
  inbox:   { specialUse: null,        fallback: "INBOX" },
  starred: { specialUse: null,        fallback: "INBOX" },
  sent:    { specialUse: "\\Sent",    fallback: "Sent" },
  drafts:  { specialUse: "\\Drafts",  fallback: "Drafts" },
  trash:   { specialUse: "\\Trash",   fallback: "Trash" },
  spam:    { specialUse: "\\Junk",    fallback: "Junk" },
  snoozed: { specialUse: null,        fallback: "INBOX" },
  all:     { specialUse: null,        fallback: "INBOX" },
};

/**
 * Which IMAP folder a drop should land in.
 *
 * A sidebar folder key resolves through special-use; anything else is one of the
 * target account's custom labels. A custom label that is mapped to an IMAP folder
 * (Settings → folder/label mapping) means the user considers label and folder the
 * same thing, so the message must be APPENDed straight into that folder — dropping
 * it into INBOX and only tagging it would leave the server copy in the wrong place.
 */
async function resolveTargetImapFolder(
  targetAccountId: string,
  targetFolderKey: string,
): Promise<string> {
  const known = FOLDER_KEY_TO_IMAP[targetFolderKey];
  if (known) {
    if (!known.specialUse) return known.fallback;
    return (await findSpecialFolder(targetAccountId, known.specialUse)) ?? known.fallback;
  }
  return (await getLabelFolderMapping(targetAccountId, targetFolderKey)) ?? "INBOX";
}

/**
 * First of these labels that is mapped to an IMAP folder, or null.
 *
 * On IMAP a label IS a folder: a moved message that ends up tagged with a mapped
 * label but parked in INBOX is in the wrong place on the server, and nothing
 * later moves it (the folder→label sync only ever adds tags, never files mail).
 */
async function resolveFolderForLabels(
  accountId: string,
  labelIds: string[],
): Promise<string | null> {
  for (const labelId of labelIds) {
    const folder = await getLabelFolderMapping(accountId, labelId);
    if (folder) return folder;
  }
  return null;
}

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
export interface CrossAccountMoveProgress {
  /** Messages fully moved (appended to target + removed from source). */
  done: number;
  /** Total messages to move across every selected thread. */
  total: number;
  /** Subject of the message currently in flight, when known. */
  currentSubject?: string | null;
}

export type CrossAccountMoveProgressCallback = (p: CrossAccountMoveProgress) => void;

export async function crossAccountMoveThreads(
  sourceAccountId: string,
  targetAccountId: string,
  threadIds: string[],
  targetFolderKey = "inbox",
  onProgress?: CrossAccountMoveProgressCallback,
): Promise<{ moved: number; total: number }> {
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

  const targetImapFolder = targetIsImap
    ? await resolveTargetImapFolder(targetAccountId, targetFolderKey)
    : "INBOX";
  const targetGmailLabels = FOLDER_KEY_TO_GMAIL[targetFolderKey] ?? ["INBOX"];

  // A drop onto one of the target account's custom labels arrives here with the
  // label id in place of a folder key. Without this the key just fell back to
  // INBOX and the label the user actually aimed at was silently dropped.
  const dropTargetLabelId =
    targetFolderKey in FOLDER_KEY_TO_IMAP
      ? null
      : await (async () => {
          const db = await getDb();
          const rows = await db.select<{ id: string }[]>(
            "SELECT id FROM user_labels WHERE account_id = $1 AND id = $2",
            [targetAccountId, targetFolderKey],
          );
          return rows[0]?.id ?? null;
        })();

  // Resolve every message up-front so the caller can show a real total: a move
  // is a raw fetch + APPEND + delete per message and can take minutes on a slow
  // server, so it must never run without visible progress.
  const perThread: { threadId: string; messages: Awaited<ReturnType<typeof getMessagesForThread>> }[] = [];
  for (const threadId of threadIds) {
    perThread.push({
      threadId,
      messages: await getMessagesForThread(sourceAccountId, threadId, true),
    });
  }
  const total = perThread.reduce((sum, t) => sum + t.messages.length, 0);
  let moved = 0;
  onProgress?.({ done: 0, total });

  for (const { threadId, messages } of perThread) {
    // Custom (user) labels that also exist by name in the target account are
    // preserved on the moved thread; labels with no match are dropped. Gmail
    // applies them server-side on insert; IMAP records a deferred assignment
    // (keyed by the message's RFC Message-ID) applied once the move is synced.
    // The dropped-on label comes first: when several of them are mapped to a
    // folder it is the one the user actually aimed at that decides the filing.
    const carryOverLabelIds = [
      ...new Set([
        ...(dropTargetLabelId ? [dropTargetLabelId] : []),
        ...(await resolveCarryOverTargetLabelIds(sourceAccountId, threadId, targetAccountId)),
      ]),
    ];
    const insertGmailLabels = [...new Set([...targetGmailLabels, ...carryOverLabelIds])];

    // Where this thread's messages are APPENDed. A drop onto a specific folder
    // (Sent/Trash/…) or onto a mapped label already resolved to it above; when
    // the drop only said "this account" — or aimed at a label with no folder
    // mapping — INBOX is a fallback, not a decision, so a carried-over label
    // that IS mapped to a folder wins. Without this, a thread whose label exists
    // in both accounts arrived tagged correctly but sitting in INBOX.
    const threadImapFolder =
      targetIsImap && targetImapFolder === "INBOX" && carryOverLabelIds.length > 0
        ? (await resolveFolderForLabels(targetAccountId, carryOverLabelIds)) ?? targetImapFolder
        : targetImapFolder;

    for (const msg of messages) {
      let rawBase64url: string;
      onProgress?.({ done: moved, total, currentSubject: msg.subject ?? null });

      // ── 1. Fetch raw from source ──────────────────────────────────────────
      if (sourceIsImap) {
        if (!sourceConfig || msg.imap_uid == null || !msg.imap_folder) continue;
        // Base64url straight from Rust over raw TCP. The previous path fetched the
        // message through async-imap and re-encoded it here with TextEncoder/btoa:
        // that parser loops on DavMail's BODY[] framing and ate all RAM+swap on a
        // move, and the UTF-8 round-trip corrupted every non-UTF-8 message.
        rawBase64url = await imapFetchRawMessageBase64(
          sourceConfig, msg.imap_folder, msg.imap_uid,
        );
      } else {
        if (!sourceGmail) continue;
        const raw = await sourceGmail.getMessage(msg.id, "raw") as { raw?: string };
        if (!raw.raw) continue;
        rawBase64url = raw.raw;
      }

      // ── 2. Insert into target ─────────────────────────────────────────────
      if (targetIsImap) {
        if (!targetConfig) continue;
        // Carry the original date over as the INTERNALDATE: without it the target
        // server stamps the append time, so every other client (and the target's
        // own sort order) would show the mail dated the day it was moved.
        await imapAppendMessage(
          targetConfig,
          threadImapFolder,
          rawBase64url,
          msg.is_read ? "(\\Seen)" : undefined,
          toImapInternalDate(msg.internal_date ?? msg.date),
        );
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

      moved += 1;
      onProgress?.({ done: moved, total, currentSubject: msg.subject ?? null });
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

  return { moved, total };
}
