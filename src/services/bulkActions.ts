// Bulk folder actions (empty trash, mark-all-read, …) — extracted from emailActions.ts.
import { getDb } from "@/services/db/connection";
import { getEmailProvider } from "@/services/email/providerFactory";
import { enqueuePendingOperation } from "@/services/db/pendingOperations";
import { classifyError } from "@/utils/networkErrors";
import { recalculateThreadStats } from "@/services/db/threads";
import { updateBadgeCount } from "@/services/badgeManager";
import { useUIStore } from "@/stores/uiStore";
import { useThreadStore } from "@/stores/threadStore";
import { trashThread, markThreadRead, type ActionResult } from "./emailActions";

/**
 * Permanently delete every trashed MESSAGE (is_trashed=1) across the given accounts.
 * Individual trashed messages are removed; a thread disappears only when it has no
 * messages left (i.e. it was composed solely of trashed messages). Threads with
 * surviving (non-trashed) messages remain, now showing only their active messages.
 */
export async function emptyTrash(accountIds: string[]): Promise<ActionResult> {
  const db = await getDb();
  const isOnline = useUIStore.getState().isOnline;

  for (const accountId of accountIds) {
    const rows = await db.select<{ id: string; thread_id: string }[]>(
      "SELECT id, thread_id FROM messages WHERE account_id = $1 AND is_trashed = 1 AND is_draft = 0",
      [accountId],
    );
    if (rows.length === 0) continue;

    const byThread = new Map<string, string[]>();
    for (const r of rows) {
      const arr = byThread.get(r.thread_id);
      if (arr) arr.push(r.id);
      else byThread.set(r.thread_id, [r.id]);
    }

    let provider: Awaited<ReturnType<typeof getEmailProvider>> | null = null;
    if (isOnline) {
      try {
        provider = await getEmailProvider(accountId);
      } catch {
        provider = null;
      }
    }

    for (const [threadId, messageIds] of byThread) {
      // 1. Server-side permanent delete (queue when offline or on retryable error)
      if (provider) {
        try {
          await provider.permanentDelete(threadId, messageIds);
        } catch (err) {
          const classified = classifyError(err);
          if (classified.isRetryable) {
            await enqueuePendingOperation(accountId, "permanentDelete", threadId, {
              threadId,
              messageIds,
            });
          } else {
            console.error("emptyTrash permanentDelete failed:", err);
          }
        }
      } else {
        await enqueuePendingOperation(accountId, "permanentDelete", threadId, {
          threadId,
          messageIds,
        });
      }

      // 2. Local DB cleanup — remove the trashed message rows
      for (const id of messageIds) {
        await db.execute(
          "DELETE FROM message_embeddings WHERE account_id = $1 AND message_id = $2",
          [accountId, id],
        );
        await db.execute("DELETE FROM messages WHERE account_id = $1 AND id = $2", [
          accountId,
          id,
        ]);
      }

      // 3. Drop the thread if nothing is left, otherwise recompute its stats/labels
      const remaining = await db.select<{ cnt: number }[]>(
        "SELECT COUNT(*) as cnt FROM messages WHERE account_id = $1 AND thread_id = $2",
        [accountId, threadId],
      );
      if ((remaining[0]?.cnt ?? 0) === 0) {
        await db.execute(
          "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2",
          [accountId, threadId],
        );
        await db.execute("DELETE FROM threads WHERE account_id = $1 AND id = $2", [
          accountId,
          threadId,
        ]);
        useThreadStore.getState().removeThread(threadId);
      } else {
        await recalculateThreadStats(accountId, threadId);
      }
    }
  }

  updateBadgeCount().catch(console.error);
  window.dispatchEvent(new Event("melo-badges-refresh"));
  return { success: true };
}

/** Mark every trashed message (is_trashed=1) as read across the given accounts. */
export async function markAllTrashRead(accountIds: string[]): Promise<ActionResult> {
  const db = await getDb();
  const isOnline = useUIStore.getState().isOnline;

  for (const accountId of accountIds) {
    const rows = await db.select<{ id: string; thread_id: string }[]>(
      "SELECT id, thread_id FROM messages WHERE account_id = $1 AND is_trashed = 1 AND is_read = 0 AND is_draft = 0",
      [accountId],
    );
    if (rows.length === 0) continue;

    await db.execute(
      "UPDATE messages SET is_read = 1 WHERE account_id = $1 AND is_trashed = 1",
      [accountId],
    );

    if (isOnline) {
      let provider: Awaited<ReturnType<typeof getEmailProvider>> | null = null;
      try {
        provider = await getEmailProvider(accountId);
      } catch {
        provider = null;
      }
      if (provider) {
        const byThread = new Map<string, string[]>();
        for (const r of rows) {
          const arr = byThread.get(r.thread_id);
          if (arr) arr.push(r.id);
          else byThread.set(r.thread_id, [r.id]);
        }
        for (const [threadId, ids] of byThread) {
          provider.markRead(threadId, ids, true).catch(() => {});
        }
      }
    }
  }

  updateBadgeCount().catch(console.error);
  window.dispatchEvent(new Event("melo-badges-refresh"));
  return { success: true };
}

/** Move every Spam thread to Trash across the given accounts. */
export async function trashAllSpam(accountIds: string[]): Promise<ActionResult> {
  const db = await getDb();
  for (const accountId of accountIds) {
    const rows = await db.select<{ thread_id: string }[]>(
      "SELECT DISTINCT thread_id FROM thread_labels WHERE account_id = $1 AND label_id = 'SPAM'",
      [accountId],
    );
    for (const r of rows) {
      await trashThread(accountId, r.thread_id, []);
    }
  }
  return { success: true };
}

/** Mark every Spam thread as read across the given accounts. */
export async function markAllSpamRead(accountIds: string[]): Promise<ActionResult> {
  const db = await getDb();
  for (const accountId of accountIds) {
    const rows = await db.select<{ thread_id: string }[]>(
      "SELECT DISTINCT thread_id FROM thread_labels WHERE account_id = $1 AND label_id = 'SPAM'",
      [accountId],
    );
    for (const r of rows) {
      await markThreadRead(accountId, r.thread_id, [], true);
    }
  }
  return { success: true };
}
