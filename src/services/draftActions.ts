// Draft lifecycle actions — extracted from emailActions.ts.
// Forward-only deps on the engine (executeEmailAction/purgeDraftFromDb) live in
// ./emailActions and are used at call-time, so there is no init-time import cycle.
import { getDb } from "@/services/db/connection";
import { getEmailProvider } from "@/services/email/providerFactory";
import { getAccount } from "@/services/db/accounts";
import { updateBadgeCount } from "@/services/badgeManager";
import { executeEmailAction, purgeDraftFromDb, type ActionResult } from "./emailActions";

/**
 * Extract the accountId embedded in an IMAP draftId (format: imap-{uuid}-{folder}-{uid}).
 * Returns null for non-IMAP IDs or if the UUID segment is not recognizable.
 */
function extractImapDraftAccountId(draftId: string): string | null {
  if (!draftId.startsWith("imap-")) return null;
  const afterPrefix = draftId.slice("imap-".length);
  // UUID is exactly 36 chars: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  if (afterPrefix.length < 37) return null;
  const candidate = afterPrefix.slice(0, 36);
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidPattern.test(candidate) ? candidate : null;
}

/**
 * Write a tombstone for an IMAP draft AND remove it from the local DB.
 * Call this BEFORE closing the composer window — both SQLite ops complete in < 50ms,
 * which is imperceptible to the user but guaranteed to finish while the JS context is alive.
 *
 * Tombstone alone prevents future re-imports, but if the draft was already imported
 * by a background sync it remains in the local messages table and keeps showing in the UI.
 * Deleting the local record here ensures immediate removal from the draft list.
 */
export async function tombstoneImapDraft(
  accountId: string,
  draftId: string,
): Promise<void> {
  if (!draftId || !draftId.startsWith("imap-")) return;
  const resolvedAccountId = extractImapDraftAccountId(draftId) ?? accountId;
  const prefix = `imap-${resolvedAccountId}-`;
  if (!draftId.startsWith(prefix)) return;
  const remainder = draftId.slice(prefix.length);
  const lastDash = remainder.lastIndexOf("-");
  if (lastDash === -1) return;
  const folder = remainder.slice(0, lastDash);
  const uid = parseInt(remainder.slice(lastDash + 1), 10);
  if (!folder || isNaN(uid)) return;

  const [{ recordDeletedImapUid }, { getDb }, killList] = await Promise.all([
    import("@/services/db/deletedImapUids"),
    import("@/services/db/connection"),
    import("@/services/db/draftKillList"),
  ]);

  // Write tombstone — prevents any future re-import of this UID
  await recordDeletedImapUid(resolvedAccountId, folder, uid).catch(() => {});

  // Also record the copy's RFC Message-ID in the draft kill-list: DavMail/Exchange
  // can renumber the draft's UID after APPEND, in which case the tombstone above
  // (and the server EXPUNGE) target a UID the copy no longer has. The sync sweep
  // then removes the re-imported phantom by Message-ID at its current UID.
  // Source: the appended-raw registry (composer window), falling back to the
  // local row's header (drafts already imported by a sync).
  try {
    let msgId = killList.getAppendedDraftMsgId(draftId);
    if (!msgId) {
      const db = await getDb();
      const rows = await db.select<{ message_id_header: string | null }[]>(
        "SELECT message_id_header FROM messages WHERE id = $1 AND account_id = $2",
        [draftId, resolvedAccountId],
      );
      msgId = rows[0]?.message_id_header ?? null;
    }
    await killList.recordDraftKill(resolvedAccountId, msgId);
  } catch (err) {
    console.warn("[tombstoneImapDraft] draft kill-list record failed:", err);
  }

  // Delete from local DB — removes from the draft list immediately even if the
  // background sync had already imported this message before the user discarded.
  try {
    const db = await getDb();
    const rows = await db.select<{ thread_id: string }[]>(
      "SELECT thread_id FROM messages WHERE id = $1 AND account_id = $2",
      [draftId, resolvedAccountId],
    );
    if (rows.length > 0) {
      const threadId = rows[0]!.thread_id;
      await db.execute(
        "DELETE FROM message_embeddings WHERE account_id = $1 AND message_id = $2",
        [resolvedAccountId, draftId],
      );
      await db.execute(
        "DELETE FROM messages WHERE id = $1 AND account_id = $2",
        [draftId, resolvedAccountId],
      );
      const remaining = await db.select<{ c: number }[]>(
        "SELECT COUNT(*) as c FROM messages WHERE thread_id = $1 AND account_id = $2",
        [threadId, resolvedAccountId],
      );
      if ((remaining[0]?.c ?? 1) === 0) {
        await db.execute(
          "DELETE FROM thread_labels WHERE thread_id = $1 AND account_id = $2",
          [resolvedAccountId, threadId],
        );
        await db.execute(
          "DELETE FROM threads WHERE id = $1 AND account_id = $2",
          [threadId, resolvedAccountId],
        );
      }
    }
  } catch (err) {
    console.warn("[tombstoneImapDraft] Local DB cleanup failed:", err);
  }
}

/**
 * Remove phantom drafts re-imported by the sync: is_draft rows whose RFC
 * Message-ID is in the draft kill-list (drafts the app already deleted, whose
 * server copy survived a UID renumber — DavMail/Exchange). Deletes each match
 * from the server at its CURRENT UID (tombstoned first) and from the local DB.
 *
 * Safe by construction: kill entries are only written when the app deliberately
 * deletes a draft copy, and every raw build embeds a fresh Message-ID — so a
 * parked reply draft, a draft from another client, or the sent copy of the same
 * email can never match.
 *
 * Called from the IMAP sync (post-store + maintenance). Returns removed count.
 */
export async function sweepKilledDrafts(accountId: string): Promise<number> {
  const db = await getDb();
  const rows = await db.select<
    { id: string; thread_id: string; imap_uid: number | null; imap_folder: string | null }[]
  >(
    `SELECT m.id, m.thread_id, m.imap_uid, m.imap_folder
     FROM messages m
     INNER JOIN draft_kill_list k
       ON k.account_id = m.account_id AND k.message_id_header = m.message_id_header
     WHERE m.account_id = $1 AND m.is_draft = 1`,
    [accountId],
  );

  const { pruneDraftKillList } = await import("@/services/db/draftKillList");

  if (rows.length === 0) {
    await pruneDraftKillList().catch(() => {});
    return 0;
  }

  const provider = await getEmailProvider(accountId);
  const { recalculateThreadStats } = await import("@/services/db/threads");

  for (const row of rows) {
    // Server side: tombstone + EXPUNGE the copy at its CURRENT coordinates
    // (imap_uid may have been renumbered after import — trust the column, not
    // the row id). provider.deleteDraft also cleans the local row if its id
    // matches the constructed one.
    if (row.imap_folder && row.imap_uid != null) {
      const serverId = `imap-${accountId}-${row.imap_folder}-${row.imap_uid}`;
      await provider.deleteDraft(serverId).catch((err) =>
        console.warn(`[sweepKilledDrafts] server delete failed for ${serverId}:`, err),
      );
    }
    // Local side: the row id can be stale after a renumber (id says uid N,
    // column says N+1) — remove it explicitly by its actual id.
    await db.execute(
      "DELETE FROM message_embeddings WHERE account_id = $1 AND message_id = $2",
      [accountId, row.id],
    );
    await db.execute("DELETE FROM messages WHERE account_id = $1 AND id = $2", [
      accountId,
      row.id,
    ]);
    const remaining = await db.select<{ c: number }[]>(
      "SELECT COUNT(*) as c FROM messages WHERE account_id = $1 AND thread_id = $2 AND is_draft = 1",
      [accountId, row.thread_id],
    );
    if ((remaining[0]?.c ?? 0) === 0) {
      await db.execute(
        "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = 'DRAFT'",
        [accountId, row.thread_id],
      );
    }
    await recalculateThreadStats(accountId, row.thread_id).catch(() => {});
  }

  console.log(`[sweepKilledDrafts] removed ${rows.length} phantom draft(s) for ${accountId}`);
  updateBadgeCount().catch(() => {});
  window.dispatchEvent(new Event("melo-badges-refresh"));

  await pruneDraftKillList().catch(() => {});
  return rows.length;
}

export async function deleteDraft(
  accountId: string,
  draftId: string,
  threadId?: string,
): Promise<ActionResult> {
  // For IMAP drafts the draftId encodes the real accountId. If separate Tauri windows
  // caused a mismatch (openComposer called without accountId param), recover here so
  // the tombstone is always written against the correct account.
  const resolvedAccountId = extractImapDraftAccountId(draftId) ?? accountId;
  // Tombstone IMAP drafts before the provider delete so background sync cannot
  // re-import the UID between the local DB removal and the server EXPUNGE.
  if (draftId.startsWith("imap-")) {
    await tombstoneImapDraft(resolvedAccountId, draftId);
  }
  return executeEmailAction(resolvedAccountId, {
    type: "deleteDraft",
    draftId,
    threadId,
  });
}

/**
 * Delete a draft thread from the Drafts folder view.
 * Routes to the correct path based on account provider:
 * - Gmail: uses the Drafts API (drafts.delete) which properly removes the draft
 * - IMAP: permanently deletes the message directly from the Drafts folder (no MOVE to Trash)
 *
 * This is the correct entry point when the user presses # in the Drafts view.
 * Never use trashThread() for drafts — IMAP MOVE assigns new UIDs, breaking
 * subsequent permanentDelete attempts.
 */
export async function deleteDraftThread(
  accountId: string,
  incomingId: string,
): Promise<void> {
  const account = await getAccount(accountId);
  if (!account) return;

  // The incoming id may be a draft MESSAGE id (Drafts view rows are individual drafts)
  // or a thread id (legacy callers). Resolve the parent thread; if it was a draft
  // message id, remember it so we scope deletion to that single draft.
  const db = await getDb();
  const draftRow = await db.select<{ thread_id: string }[]>(
    "SELECT thread_id FROM messages WHERE account_id = $1 AND id = $2 AND is_draft = 1",
    [accountId, incomingId],
  );
  const resolvedDraftId = draftRow[0] ? incomingId : null;
  const threadId = draftRow[0]?.thread_id ?? incomingId;

  if (account.provider === "gmail_api") {
    const { getGmailClient } = await import("@/services/gmail/tokenManager");
    const { deleteDraftsForThread } =
      await import("@/services/gmail/draftDeletion");
    const client = await getGmailClient(accountId);
    await deleteDraftsForThread(client, accountId, threadId);
  } else {
    // IMAP: delete ONLY the draft message(s) — never the original received emails.
    // Read the draft UIDs from the DB before purging the local rows.
    const draftRows = resolvedDraftId
      ? await db.select<{ id: string; imap_uid: number | null; imap_folder: string | null }[]>(
          "SELECT id, imap_uid, imap_folder FROM messages WHERE account_id = $1 AND thread_id = $2 AND is_draft = 1 AND id = $3",
          [accountId, threadId, resolvedDraftId],
        )
      : await db.select<{ id: string; imap_uid: number | null; imap_folder: string | null }[]>(
          "SELECT id, imap_uid, imap_folder FROM messages WHERE account_id = $1 AND thread_id = $2 AND is_draft = 1",
          [accountId, threadId],
        );

    const provider = await getEmailProvider(accountId);
    // provider.deleteDraft (IMAP) already tombstones + EXPUNGEs the single UID and
    // cleans the local row, so no separate tombstoneImapDraft call is needed here.
    const seen = new Set<string>();
    for (const row of draftRows) {
      if (row.imap_uid != null && row.imap_folder) {
        const msgId = `imap-${accountId}-${row.imap_folder}-${row.imap_uid}`;
        if (seen.has(msgId)) continue;
        seen.add(msgId);
        await provider.deleteDraft(msgId).catch((err) =>
          console.warn("[deleteDraftThread] IMAP delete failed:", err),
        );
      }
    }

    // Local single-draft cleanup: sweeps is_draft=1 rows and keeps the thread if it
    // still has non-draft messages (reply draft), else removes the empty thread.
    await purgeDraftFromDb(accountId, resolvedDraftId, threadId);
  }

  // Refresh sidebar draft badge — deleteDraftThread bypasses executeEmailAction
  // so we must trigger it manually here (same as executeEmailAction lines 419-420).
  updateBadgeCount().catch(console.error);
  window.dispatchEvent(new Event("melo-badges-refresh"));
}
