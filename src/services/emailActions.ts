import { useUIStore } from "@/stores/uiStore";
import { useThreadStore } from "@/stores/threadStore";
import { getEmailProvider } from "@/services/email/providerFactory";
import { enqueuePendingOperation } from "@/services/db/pendingOperations";
import { classifyError } from "@/utils/networkErrors";
import { getDb } from "@/services/db/connection";
import { navigateToThread, navigateBack, getSelectedThreadId } from "@/router/navigate";
import { getAccount } from "@/services/db/accounts";
import { updateBadgeCount } from "@/services/badgeManager";

// ---------------------------------------------------------------------------
// Action types
// ---------------------------------------------------------------------------

export type EmailAction =
  | { type: "archive"; threadId: string; messageIds: string[] }
  | { type: "trash"; threadId: string; messageIds: string[] }
  | { type: "permanentDelete"; threadId: string; messageIds: string[] }
  | {
      type: "markRead";
      threadId: string;
      messageIds: string[];
      read: boolean;
    }
  | {
      type: "star";
      threadId: string;
      messageIds: string[];
      starred: boolean;
    }
  | {
      type: "spam";
      threadId: string;
      messageIds: string[];
      isSpam: boolean;
    }
  | {
      type: "moveToFolder";
      threadId: string;
      messageIds: string[];
      folderPath: string;
    }
  | { type: "addLabel"; threadId: string; labelId: string }
  | { type: "removeLabel"; threadId: string; labelId: string }
  | {
      type: "sendMessage";
      rawBase64Url: string;
      threadId?: string;
      // Draft-cleanup hints carried only by sends that were queued after a failed
      // attempt. When the retry finally succeeds, the queue path uses these to delete
      // the draft that the failed-send handler intentionally left behind (otherwise
      // the draft + its phantom "unread in inbox" lingers forever). Absent on normal
      // online sends, which clean the draft up directly in the send handler.
      cleanupDraftId?: string;
      cleanupLocalDraftId?: string;
    }
  | {
      // IMAP only: retry the copy-to-Sent APPEND after an SMTP-delivered send whose
      // Sent APPEND failed. The message was already delivered — this only reconciles
      // the server Sent folder and the placeholder local row.
      type: "appendToSent";
      rawBase64Url: string;
      threadId?: string;
      localMessageId?: string;
    }
  | {
      type: "createDraft";
      rawBase64Url: string;
      threadId?: string;
    }
  | {
      type: "updateDraft";
      draftId: string;
      rawBase64Url: string;
      threadId?: string;
    }
  | { type: "deleteDraft"; draftId: string; threadId?: string };

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface ActionResult {
  success: boolean;
  queued?: boolean;
  error?: string;
  data?: unknown;
}

// ---------------------------------------------------------------------------
// Optimistic UI helpers
// ---------------------------------------------------------------------------

export function getNextThreadId(currentId: string): string | null {
  // Only auto-advance if the removed thread is the one being viewed
  const selectedId = getSelectedThreadId();
  if (selectedId !== currentId) return null;
  const { threads } = useThreadStore.getState();
  const idx = threads.findIndex((t) => t.id === currentId);
  if (idx === -1) return null;
  // Prefer next thread, fall back to previous
  const next = threads[idx + 1];
  if (next) return next.id;
  const prev = threads[idx - 1];
  if (prev) return prev.id;
  return null;
}

function applyOptimisticUpdate(action: EmailAction): void {
  const store = useThreadStore.getState();
  switch (action.type) {
    case "archive":
    case "trash":
    case "permanentDelete":
    case "spam":
    case "moveToFolder": {
      // Capture whether the removed thread is the one being viewed *before* removing it —
      // getNextThreadId only returns a sibling when the removed thread is selected.
      const isViewing = getSelectedThreadId() === action.threadId;
      const nextId = getNextThreadId(action.threadId);
      store.removeThread(action.threadId);
      if (nextId) {
        navigateToThread(nextId);
      } else if (isViewing) {
        // No sibling to advance to (e.g. the last thread in a smart folder). Deselect so the
        // reading pane empties and the deep-link safety net doesn't re-fetch the removed thread.
        navigateBack();
      }
      break;
    }
    case "markRead":
      if (action.messageIds.length > 0 && action.read) {
        const thread = store.threadMap.get(action.threadId);
        const newUnreadCount = Math.max(0, (thread?.unreadCount ?? 0) - action.messageIds.length);
        store.updateThread(action.threadId, {
          unreadCount: newUnreadCount,
          ...(newUnreadCount === 0 ? { isRead: true } : {}),
        });
      } else {
        store.updateThread(action.threadId, {
          isRead: action.read,
          ...(action.read ? { unreadCount: 0 } : {}),
        });
      }
      break;
    case "star":
      store.updateThread(action.threadId, { isStarred: action.starred });
      break;
    case "addLabel":
    case "removeLabel":
    case "sendMessage":
    case "createDraft":
    case "updateDraft":
      // No universal optimistic update for these
      break;
    case "deleteDraft":
      // Remove from the current in-memory view (e.g. Drafts list).
      // This only affects the loaded thread list — navigating to INBOX reloads from DB.
      if (action.threadId) {
        store.removeThread(action.threadId);
      }
      break;
  }
}

function revertOptimisticUpdate(action: EmailAction): void {
  const store = useThreadStore.getState();
  switch (action.type) {
    case "markRead":
      store.updateThread(action.threadId, { isRead: !action.read });
      break;
    case "star":
      store.updateThread(action.threadId, { isStarred: !action.starred });
      break;
    // For removes (archive/trash/spam/move), we can't easily restore the thread
    // to the list from here. The next sync will fix it.
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the correct INBOX/SENT labels for a thread based on from_address.
 * Used when restoring a thread from TRASH/SPAM/ARCHIVE so the result
 * matches the same logic applied during IMAP sync.
 */
async function resolveInboxSentLabels(
  accountId: string,
  threadId: string,
): Promise<{ inbox: boolean; sent: boolean }> {
  const account = await getAccount(accountId);
  if (!account) return { inbox: true, sent: false };

  const db = await getDb();
  const rows = await db.select<{ from_address: string | null; date: number }[]>(
    "SELECT from_address, date FROM messages WHERE account_id = $1 AND thread_id = $2 ORDER BY date ASC",
    [accountId, threadId],
  );
  if (rows.length === 0) return { inbox: true, sent: false };

  const lowerEmail = account.email.toLowerCase();
  const isFromMe = (addr: string | null) => !!addr && addr.toLowerCase() === lowerEmail;
  const last = rows[rows.length - 1]!;

  return {
    sent: isFromMe(last.from_address),
    inbox: rows.some((r) => !isFromMe(r.from_address)),
  };
}

/**
 * Mark every non-draft message of a thread as trashed locally (is_trashed=1, is_read=1).
 * For Gmail also rewrites gmail_label_ids to TRASH. IMAP coordinates (imap_uid/imap_folder)
 * are kept intact so the provider can still resolve the server UIDs to move; the next sync
 * reconciles the folder. This mirrors the per-message logic in deleteSingleMessage but for
 * the whole thread, so whole-thread trash and single-message trash share the is_trashed
 * model the Trash view relies on.
 */
async function markThreadMessagesTrashed(
  accountId: string,
  threadId: string,
): Promise<void> {
  const db = await getDb();
  const probe = await db.select<{ gmail_label_ids: string | null }[]>(
    "SELECT gmail_label_ids FROM messages WHERE account_id = $1 AND thread_id = $2 AND is_draft = 0 LIMIT 1",
    [accountId, threadId],
  );
  const isGmail =
    probe[0]?.gmail_label_ids !== null && probe[0]?.gmail_label_ids !== undefined;
  if (isGmail) {
    await db.execute(
      `UPDATE messages SET gmail_label_ids = '["TRASH"]', is_trashed = 1, is_read = 1 WHERE account_id = $1 AND thread_id = $2 AND is_draft = 0`,
      [accountId, threadId],
    );
  } else {
    await db.execute(
      "UPDATE messages SET is_trashed = 1, is_read = 1 WHERE account_id = $1 AND thread_id = $2 AND is_draft = 0",
      [accountId, threadId],
    );
  }
}

/**
 * Reverse of markThreadMessagesTrashed: clear is_trashed and drop the TRASH label when a
 * thread is restored out of Trash (moved to Inbox / another folder, or reported as spam).
 * Safe to call on non-trashed threads — it is a no-op there.
 */
async function untrashThreadMessages(
  accountId: string,
  threadId: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE messages SET is_trashed = 0 WHERE account_id = $1 AND thread_id = $2",
    [accountId, threadId],
  );
  await db.execute(
    "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = 'TRASH'",
    [accountId, threadId],
  );
}

// ---------------------------------------------------------------------------
// Local DB updates (so offline reads reflect changes)
// ---------------------------------------------------------------------------

async function applyLocalDbUpdate(
  accountId: string,
  action: EmailAction,
): Promise<void> {
  const db = await getDb();
  switch (action.type) {
    case "markRead":
      if (action.messageIds.length > 0) {
        const placeholders = action.messageIds.map((_, i) => `$${i + 3}`).join(",");
        await db.execute(
          `UPDATE messages SET is_read = $1 WHERE account_id = $2 AND id IN (${placeholders})`,
          [action.read ? 1 : 0, accountId, ...action.messageIds],
        );
        const remaining = await db.select<{ cnt: number }[]>(
          "SELECT COUNT(*) as cnt FROM messages WHERE account_id = $1 AND thread_id = $2 AND is_read = 0 AND is_draft = 0 AND is_trashed = 0",
          [accountId, action.threadId],
        );
        const allRead = (remaining[0]?.cnt ?? 0) === 0;
        await db.execute(
          "UPDATE threads SET is_read = $1 WHERE account_id = $2 AND id = $3",
          [allRead ? 1 : 0, accountId, action.threadId],
        );
      } else {
        await db.execute(
          "UPDATE threads SET is_read = $1 WHERE account_id = $2 AND id = $3",
          [action.read ? 1 : 0, accountId, action.threadId],
        );
        await db.execute(
          "UPDATE messages SET is_read = $1 WHERE account_id = $2 AND thread_id = $3",
          [action.read ? 1 : 0, accountId, action.threadId],
        );
      }
      break;
    case "star":
      await db.execute(
        "UPDATE threads SET is_starred = $1 WHERE account_id = $2 AND id = $3",
        [action.starred ? 1 : 0, accountId, action.threadId],
      );
      await db.execute(
        "UPDATE messages SET is_starred = $1 WHERE account_id = $2 AND thread_id = $3",
        [action.starred ? 1 : 0, accountId, action.threadId],
      );
      if (action.starred) {
        await db.execute(
          "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, 'STARRED')",
          [accountId, action.threadId],
        );
      } else {
        await db.execute(
          "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = 'STARRED'",
          [accountId, action.threadId],
        );
      }
      break;
    case "archive":
      await db.execute(
        "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = 'INBOX'",
        [accountId, action.threadId],
      );
      break;
    case "trash":
      await db.execute(
        "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id IN ('INBOX', 'DRAFT', 'SPAM', 'SENT')",
        [accountId, action.threadId],
      );
      await db.execute(
        "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, 'TRASH')",
        [accountId, action.threadId],
      );
      await db.execute(
        "UPDATE threads SET is_read = 1 WHERE account_id = $1 AND id = $2",
        [accountId, action.threadId],
      );
      // Mark all messages trashed (is_trashed=1) so the message-based Trash view shows them.
      await markThreadMessagesTrashed(accountId, action.threadId);
      break;
    case "permanentDelete":
      await db.execute(
        "DELETE FROM threads WHERE account_id = $1 AND id = $2",
        [accountId, action.threadId],
      );
      break;
    case "spam":
      if (action.isSpam) {
        await db.execute(
          "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id IN ('INBOX', 'TRASH')",
          [accountId, action.threadId],
        );
        await db.execute(
          "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, 'SPAM')",
          [accountId, action.threadId],
        );
        // Reporting spam moves the thread out of Trash — clear is_trashed.
        await db.execute(
          "UPDATE messages SET is_trashed = 0 WHERE account_id = $1 AND thread_id = $2",
          [accountId, action.threadId],
        );
      } else {
        await db.execute(
          "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = 'SPAM'",
          [accountId, action.threadId],
        );
        const { inbox, sent } = await resolveInboxSentLabels(accountId, action.threadId);
        if (inbox) {
          await db.execute(
            "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, 'INBOX')",
            [accountId, action.threadId],
          );
        }
        if (sent) {
          await db.execute(
            "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, 'SENT')",
            [accountId, action.threadId],
          );
        }
      }
      break;
    case "addLabel":
      // Remove any existing user label on this thread before adding the new one.
      // System labels (INBOX, SENT, etc.) live in thread_labels but not in user_labels,
      // so the JOIN ensures only user-created labels are replaced.
      await db.execute(
        `DELETE FROM thread_labels
         WHERE account_id = $1 AND thread_id = $2
           AND label_id IN (SELECT id FROM user_labels WHERE account_id = $1)`,
        [accountId, action.threadId],
      );
      await db.execute(
        "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, $3)",
        [accountId, action.threadId, action.labelId],
      );
      // Restoring to Inbox un-trashes the thread's messages.
      if (action.labelId === "INBOX") {
        await untrashThreadMessages(accountId, action.threadId);
      }
      break;
    case "moveToFolder":
      // Moving a thread to a folder restores it out of Trash (the dialog never uses
      // moveToFolder to trash — it calls trashThread). No-op if the thread wasn't trashed.
      await untrashThreadMessages(accountId, action.threadId);
      break;
    case "removeLabel":
      await db.execute(
        "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = $3",
        [accountId, action.threadId, action.labelId],
      );
      break;
    case "deleteDraft": {
      await purgeDraftFromDb(accountId, action.draftId, action.threadId ?? null);
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Core execution
// ---------------------------------------------------------------------------

function getResourceId(action: EmailAction): string {
  if ("threadId" in action && action.threadId) return action.threadId;
  if ("draftId" in action) return action.draftId;
  return crypto.randomUUID();
}

function actionToParams(action: EmailAction): Record<string, unknown> {
  // Strip the type field — it's stored separately as operation_type
  const { type: _, ...rest } = action;
  return rest;
}

async function executeViaProvider(
  accountId: string,
  action: EmailAction,
): Promise<unknown> {
  const provider = await getEmailProvider(accountId);
  switch (action.type) {
    case "archive":
      return provider.archive(action.threadId, action.messageIds);
    case "trash": {
      await provider.trash(action.threadId, action.messageIds);
      provider.markRead(action.threadId, action.messageIds, true).catch(() => {});
      return;
    }
    case "permanentDelete":
      return provider.permanentDelete(action.threadId, action.messageIds);
    case "markRead":
      return provider.markRead(action.threadId, action.messageIds, action.read);
    case "star":
      return provider.star(action.threadId, action.messageIds, action.starred);
    case "spam":
      return provider.spam(action.threadId, action.messageIds, action.isSpam);
    case "moveToFolder":
      return provider.moveToFolder(
        action.threadId,
        action.messageIds,
        action.folderPath,
      );
    case "addLabel":
      return provider.addLabel(action.threadId, action.labelId);
    case "removeLabel":
      return provider.removeLabel(action.threadId, action.labelId);
    case "sendMessage": {
      const result = await provider.sendMessage(action.rawBase64Url, action.threadId);
      // A retry that originated from a failed send carries cleanup hints: now that the
      // send finally went through, remove the draft left behind. Mirrors the success
      // path in App.tsx's melo-execute-send handler.
      if (action.cleanupDraftId) {
        const { deleteDraft } = await import("./draftActions");
        await deleteDraft(accountId, action.cleanupDraftId, action.threadId).catch(() => {});
      } else if (action.cleanupLocalDraftId) {
        await purgeDraftFromDb(
          accountId,
          null,
          action.threadId ?? null,
          action.cleanupLocalDraftId,
        ).catch(() => {});
      }
      return result;
    }
    case "appendToSent": {
      // Only the IMAP provider implements this (Gmail saves to Sent server-side).
      const p = provider as unknown as {
        appendToSent?: (raw: string, threadId?: string, localMessageId?: string) => Promise<{ id: string }>;
      };
      if (p.appendToSent) {
        return p.appendToSent(action.rawBase64Url, action.threadId, action.localMessageId);
      }
      return;
    }
    case "createDraft":
      return provider.createDraft(action.rawBase64Url, action.threadId);
    case "updateDraft":
      return provider.updateDraft(
        action.draftId,
        action.rawBase64Url,
        action.threadId,
      );
    case "deleteDraft":
      return provider.deleteDraft(action.draftId, action.threadId);
  }
}

export async function executeEmailAction(
  accountId: string,
  action: EmailAction,
): Promise<ActionResult> {
  // 1. Optimistic UI update
  applyOptimisticUpdate(action);

  // For addLabel: capture existing user labels BEFORE the local delete so we can
  // remove them from the server (Gmail) after the local DB is updated.
  let labelIdsToRemove: string[] = [];
  if (action.type === "addLabel") {
    const db = await getDb();
    const rows = await db.select<{ label_id: string }[]>(
      `SELECT tl.label_id FROM thread_labels tl
       INNER JOIN user_labels ul ON ul.id = tl.label_id AND ul.account_id = tl.account_id
       WHERE tl.account_id = $1 AND tl.thread_id = $2 AND tl.label_id != $3`,
      [accountId, action.threadId, action.labelId],
    );
    labelIdsToRemove = rows.map((r) => r.label_id);
  }

  // 2. Local DB update
  try {
    await applyLocalDbUpdate(accountId, action);
  } catch (err) {
    console.warn("Local DB update failed:", err);
  }

  // Immediately refresh sidebar badges from the updated DB — no need to wait for
  // the network call. melo-badges-refresh is handled without debounce in the Sidebar.
  const affectsBadges =
    action.type === "markRead" ||
    action.type === "archive" ||
    action.type === "trash" ||
    action.type === "spam" ||
    action.type === "permanentDelete" ||
    action.type === "deleteDraft";
  if (affectsBadges) {
    updateBadgeCount().catch(console.error);
    window.dispatchEvent(new Event("melo-badges-refresh"));
  }

  // 3. If offline, queue
  if (!useUIStore.getState().isOnline) {
    await enqueuePendingOperation(
      accountId,
      action.type,
      getResourceId(action),
      actionToParams(action),
    );
    return { success: true, queued: true };
  }

  // 4. Try online execution
  try {
    if (action.type === "addLabel" && labelIdsToRemove.length > 0) {
      const provider = await getEmailProvider(accountId);
      await Promise.all(labelIdsToRemove.map((id) => provider.removeLabel(action.threadId, id)));
    }
    const data = await executeViaProvider(accountId, action);
    window.dispatchEvent(new Event("melo-sync-done"));
    return { success: true, data };
  } catch (err) {
    const classified = classifyError(err);

    if (classified.isRetryable) {
      // Queue for retry
      await enqueuePendingOperation(
        accountId,
        action.type,
        getResourceId(action),
        actionToParams(action),
      );
      return { success: true, queued: true };
    }

    // Permanent error — revert optimistic update
    revertOptimisticUpdate(action);
    console.error(`Email action ${action.type} failed permanently:`, err);
    return { success: false, error: classified.message };
  }
}

// ---------------------------------------------------------------------------
// Execute a queued operation (used by queue processor)
// ---------------------------------------------------------------------------

export async function executeQueuedAction(
  accountId: string,
  operationType: string,
  params: Record<string, unknown>,
): Promise<void> {
  const action = { type: operationType, ...params } as EmailAction;
  await executeViaProvider(accountId, action);
}

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

export function archiveThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "archive",
    threadId,
    messageIds,
  });
}

export function trashThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "trash",
    threadId,
    messageIds,
  });
}

export function permanentDeleteThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "permanentDelete",
    threadId,
    messageIds,
  });
}

export function markThreadRead(
  accountId: string,
  threadId: string,
  messageIds: string[],
  read: boolean,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "markRead",
    threadId,
    messageIds,
    read,
  });
}

export function starThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
  starred: boolean,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "star",
    threadId,
    messageIds,
    starred,
  });
}

export function spamThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
  isSpam: boolean,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "spam",
    threadId,
    messageIds,
    isSpam,
  });
}

export function moveThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
  folderPath: string,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "moveToFolder",
    threadId,
    messageIds,
    folderPath,
  });
}

export function addThreadLabel(
  accountId: string,
  threadId: string,
  labelId: string,
): Promise<ActionResult> {
  return executeEmailAction(accountId, { type: "addLabel", threadId, labelId });
}

export function removeThreadLabel(
  accountId: string,
  threadId: string,
  labelId: string,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "removeLabel",
    threadId,
    labelId,
  });
}

/**
 * Extract a plain-text snippet from the reply body for urgency AI judgment.
 * Decodes base64url, finds the body after the header block, strips HTML tags.
 */
function extractReplyTextFromRaw(rawBase64Url: string): string | null {
  try {
    let base64 = rawBase64Url.replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4 !== 0) base64 += "=";
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const raw = new TextDecoder().decode(bytes);
    const bodyStart = raw.indexOf("\r\n\r\n");
    if (bodyStart === -1) return null;
    const body = raw.slice(bodyStart + 4);
    const text = body
      .replace(/--[^\r\n]+/g, "")
      .replace(/Content-[^\r\n]+/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500);
    return text || null;
  } catch {
    return null;
  }
}

export async function sendEmail(
  accountId: string,
  rawBase64Url: string,
  threadId?: string,
): Promise<ActionResult> {
  const result = await executeEmailAction(accountId, {
    type: "sendMessage",
    rawBase64Url,
    threadId,
  });

  if (result.success) {
    window.dispatchEvent(new Event("melo-sync-done"));
    // Auto-extinguish urgency when a reply resolves the thread
    if (threadId) {
      const replyText = extractReplyTextFromRaw(rawBase64Url) ?? undefined;
      import("./ai/heatExtinguisher").then(({ autoExtinguishOnReply }) => {
        autoExtinguishOnReply(accountId, threadId, replyText).catch(() => {});
      });
    }
  }

  return result;
}

export function createDraft(
  accountId: string,
  rawBase64Url: string,
  threadId?: string,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "createDraft",
    rawBase64Url,
    threadId,
  });
}

export function updateDraft(
  accountId: string,
  draftId: string,
  rawBase64Url: string,
  threadId?: string,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "updateDraft",
    draftId,
    rawBase64Url,
    threadId,
  });
}


/**
 * Remove a draft from the local DB completely and idempotently. Resolves the thread
 * from any of threadId / draftId / localDraftId, deletes the explicit row(s), then
 * sweeps every remaining is_draft=1 row in the thread (covers the IMAP stable-UUID row
 * whose id matches neither the server draftId nor a Gmail API id). If no messages remain
 * the thread + its labels are removed; otherwise only the DRAFT label is dropped and the
 * thread's read state recomputed.
 *
 * Call this synchronously (awaited) before closing a composer window — it is all fast
 * SQLite, so it always finishes while the JS context is alive, unlike a fire-and-forget
 * cleanup that the closing window would interrupt.
 */
export async function purgeDraftFromDb(
  accountId: string,
  draftId: string | null,
  threadId: string | null,
  localDraftId?: string | null,
): Promise<void> {
  const db = await getDb();
  const candidateIds = [draftId, localDraftId].filter(
    (x): x is string => typeof x === "string" && x.length > 0,
  );

  let tid = threadId ?? null;
  if (!tid) {
    for (const id of candidateIds) {
      const row = await db.select<{ thread_id: string }[]>(
        "SELECT thread_id FROM messages WHERE account_id = $1 AND id = $2",
        [accountId, id],
      );
      if (row[0]) {
        tid = row[0].thread_id;
        break;
      }
    }
  }

  // Delete the explicit draft message row(s) by id.
  // For IMAP the local id is the stable UUID; for Gmail the API id won't match a row
  // (the thread sweep below handles it).
  for (const id of candidateIds) {
    await db.execute(
      "DELETE FROM message_embeddings WHERE account_id = $1 AND message_id = $2",
      [accountId, id],
    );
    await db.execute(
      "DELETE FROM messages WHERE account_id = $1 AND id = $2",
      [accountId, id],
    );
  }

  if (!tid) return;

  // Sweep every remaining draft message in the thread.
  const draftMsgs = await db.select<{ id: string }[]>(
    "SELECT id FROM messages WHERE account_id = $1 AND thread_id = $2 AND is_draft = 1",
    [accountId, tid],
  );
  for (const msg of draftMsgs) {
    await db.execute(
      "DELETE FROM message_embeddings WHERE account_id = $1 AND message_id = $2",
      [accountId, msg.id],
    );
    await db.execute(
      "DELETE FROM messages WHERE account_id = $1 AND id = $2",
      [accountId, msg.id],
    );
  }

  const remaining = await db.select<{ id: string }[]>(
    "SELECT id FROM messages WHERE account_id = $1 AND thread_id = $2 LIMIT 1",
    [accountId, tid],
  );
  if (remaining.length === 0) {
    // Thread is now empty: remove it completely (this is what clears the Drafts badge).
    await db.execute(
      "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2",
      [accountId, tid],
    );
    await db.execute(
      "DELETE FROM threads WHERE account_id = $1 AND id = $2",
      [accountId, tid],
    );
  } else {
    // Thread still has messages (e.g. reply draft on an existing thread): drop DRAFT label.
    await db.execute(
      "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = 'DRAFT'",
      [accountId, tid],
    );
    // The draft was is_read=0; recompute so a fully-read thread doesn't keep a stale
    // UNREAD label after the draft is gone.
    const unreadRemaining = await db.select<{ id: string }[]>(
      "SELECT id FROM messages WHERE account_id = $1 AND thread_id = $2 AND is_read = 0 LIMIT 1",
      [accountId, tid],
    );
    if (unreadRemaining.length === 0) {
      await db.execute(
        "UPDATE threads SET is_read = 1 WHERE account_id = $1 AND id = $2",
        [accountId, tid],
      );
      await db.execute(
        "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = 'UNREAD'",
        [accountId, tid],
      );
    }
  }
}


// ---------------------------------------------------------------------------
// Bulk Trash / Spam operations (toolbar actions)
//
// Scope is an explicit list of account ids: a single id in single-account view,
// or every included account id in the unified view.
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Re-exports — implementations split into focused modules for readability.
// (Barrel only: callers keep importing from "@/services/emailActions".)
// ---------------------------------------------------------------------------
export { deleteDraft, deleteDraftThread, tombstoneImapDraft } from "./draftActions";
export { deleteSingleMessage, trashLatestMessage } from "./messageActions";
export { emptyTrash, markAllTrashRead, trashAllSpam, markAllSpamRead } from "./bulkActions";
