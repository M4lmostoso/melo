// Single-message delete/trash actions — extracted from emailActions.ts.
import { getDb } from "@/services/db/connection";
import { getEmailProvider } from "@/services/email/providerFactory";
import { enqueuePendingOperation } from "@/services/db/pendingOperations";
import { classifyError } from "@/utils/networkErrors";
import { recalculateThreadStats, getThreadById } from "@/services/db/threads";
import { getMessagesForThread } from "@/services/db/messages";
import { updateBadgeCount } from "@/services/badgeManager";
import { navigateToThread } from "@/router/navigate";
import { useUIStore } from "@/stores/uiStore";
import { useThreadStore } from "@/stores/threadStore";
import { getNextThreadId, markPendingRemoval, type ActionResult } from "./emailActions";

/**
 * Delete a single message within a thread.
 * When permanent=true: hard-deletes from DB (used when message is already in Trash).
 * When permanent=false: soft-trashes — message stays in DB with is_trashed=1 so it appears
 *   immediately in the Trash view, then the server is informed asynchronously.
 * If soft-trashing removes all non-trashed messages in the thread, the thread moves to Trash view.
 * Thread metadata (message_count, last_message_at) always reflects non-trashed messages only.
 */
export async function deleteSingleMessage(
  accountId: string,
  threadId: string,
  messageId: string,
  permanent: boolean = false,
): Promise<ActionResult> {
  const db = await getDb();

  if (permanent) {
    // Hard-delete: remove from DB entirely
    await db.execute("DELETE FROM message_embeddings WHERE account_id = $1 AND message_id = $2", [accountId, messageId]);
    await db.execute("DELETE FROM messages WHERE account_id = $1 AND id = $2", [accountId, messageId]);
  } else {
    // Soft-trash: mark as trashed locally. For Gmail, clear all labels and set TRASH.
    // For IMAP, move to Trash folder path and set is_trashed=1.
    const trashLabelRow = await db.select<{ imap_folder_path: string | null }[]>(
      "SELECT imap_folder_path FROM labels WHERE account_id = $1 AND id = 'TRASH'",
      [accountId],
    );
    const trashFolderPath = trashLabelRow[0]?.imap_folder_path ?? null;

    // Check if this is a Gmail message (has gmail_label_ids) or IMAP (has imap_folder)
    const msgRow = await db.select<{ gmail_label_ids: string | null; imap_folder: string | null }[]>(
      "SELECT gmail_label_ids, imap_folder FROM messages WHERE account_id = $1 AND id = $2",
      [accountId, messageId],
    );
    const isGmail = msgRow[0]?.gmail_label_ids !== null && msgRow[0]?.gmail_label_ids !== undefined;

    if (isGmail) {
      await db.execute(
        "UPDATE messages SET gmail_label_ids = '[\"TRASH\"]', is_trashed = 1, is_read = 1 WHERE account_id = $1 AND id = $2",
        [accountId, messageId],
      );
    } else if (trashFolderPath) {
      await db.execute(
        "UPDATE messages SET imap_folder = $3, imap_uid = NULL, is_trashed = 1, is_read = 1 WHERE account_id = $1 AND id = $2",
        [accountId, messageId, trashFolderPath],
      );
    } else {
      // Fallback: just mark as trashed in-place
      await db.execute(
        "UPDATE messages SET is_trashed = 1, is_read = 1 WHERE account_id = $1 AND id = $2",
        [accountId, messageId],
      );
    }
  }

  // Check remaining non-trashed messages in thread
  const remaining = await getMessagesForThread(accountId, threadId);

  // Optimistic UI
  if (remaining.length === 0) {
    if (permanent) {
      await db.execute("DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2", [accountId, threadId]);
      await db.execute("DELETE FROM threads WHERE account_id = $1 AND id = $2", [accountId, threadId]);
    } else {
      // All messages trashed — move thread to TRASH view
      await db.execute(
        "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id IN ('INBOX', 'DRAFT', 'SPAM', 'SENT')",
        [accountId, threadId],
      );
      await db.execute(
        "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, 'TRASH')",
        [accountId, threadId],
      );
      await db.execute("UPDATE threads SET is_read = 1 WHERE account_id = $1 AND id = $2", [accountId, threadId]);
      useThreadStore.getState().updateThread(threadId, { isRead: true });
    }
    const nextId = getNextThreadId(threadId);
    useThreadStore.getState().removeThread(threadId);
    if (nextId) markPendingRemoval(threadId, navigateToThread(nextId));
  } else {
    // Recalculate thread stats and labels reflecting the soft-trashed message
    await recalculateThreadStats(accountId, threadId);
    const updated = await getThreadById(accountId, threadId);
    if (updated) {
      useThreadStore.getState().updateThread(threadId, {
        messageCount: updated.message_count,
        unreadCount: updated.unread_count,
        lastMessageAt: updated.last_message_at ?? 0,
        isRead: updated.is_read === 1,
        snippet: updated.snippet,
        fromName: updated.from_name,
        fromAddress: updated.from_address,
        allSenders: updated.all_senders,
      });
    }
    window.dispatchEvent(new CustomEvent("melo-message-deleted", { detail: { messageId, threadId } }));
  }

  // Refresh sidebar badges — mirrors the same logic in executeEmailAction.
  updateBadgeCount().catch(console.error);
  window.dispatchEvent(new Event("melo-badges-refresh"));

  // 4. If offline, queue
  if (!useUIStore.getState().isOnline) {
    const actionType = permanent ? "permanentDelete" : "trash";
    await enqueuePendingOperation(accountId, actionType, messageId, {
      threadId,
      messageIds: [messageId],
    });
    return { success: true, queued: true };
  }

  // 5. Execute via provider
  try {
    const provider = await getEmailProvider(accountId);
    if (permanent) {
      await provider.permanentDelete(threadId, [messageId]);
    } else {
      await provider.trash(threadId, [messageId]);
    }
    return { success: true };
  } catch (err) {
    const classified = classifyError(err);
    if (classified.isRetryable) {
      const actionType = permanent ? "permanentDelete" : "trash";
      await enqueuePendingOperation(accountId, actionType, messageId, {
        threadId,
        messageIds: [messageId],
      });
      return { success: true, queued: true };
    }
    console.error("deleteSingleMessage failed:", err);
    return { success: false, error: classified.message };
  }
}

/**
 * Trash (or permanently delete) only the most recent message in a thread.
 * If it's the last message and non-permanent, the thread is soft-trashed (labels updated to TRASH).
 * If permanent, the thread is hard-deleted from DB.
 */
export async function trashLatestMessage(
  accountId: string,
  threadId: string,
  permanent: boolean = false,
): Promise<ActionResult> {
  const msgs = await getMessagesForThread(accountId, threadId);
  if (msgs.length === 0) return { success: false, error: "No messages in thread" };
  const latest = msgs[msgs.length - 1] as (typeof msgs)[number] | undefined;
  if (!latest) return { success: false, error: "No messages in thread" };
  return deleteSingleMessage(accountId, threadId, latest.id, permanent);
}
