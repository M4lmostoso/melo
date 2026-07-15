// Draft kill-list: RFC Message-IDs of server drafts the app deliberately deleted.
//
// Why it exists: DavMail/Exchange renumber draft UIDs after APPEND (the APPENDUID
// response can be stale by the time we act on it), so the send/discard-time EXPUNGE
// targeting that UID can miss the real server copy. The leftover copy is then
// re-imported by the next delta sync as a phantom draft of an already-sent email.
// UIDs are unreliable on such servers; the RFC Message-ID embedded in the appended
// raw is not. Recording the Message-ID of every draft copy we intend to kill lets
// the sync sweep remove any re-import — at whatever UID it currently has.
import { getDb } from "./connection";

const KILL_LIST_TTL_DAYS = 30;

// ---------------------------------------------------------------------------
// In-memory registry: draftId → RFC Message-ID of the raw that was APPENDed.
// Populated by draftAutoSave.saveServer() right after each APPEND, read by
// tombstoneImapDraft / provider.deleteDraft when that copy is deleted. Lives in
// the composer window's JS context — for drafts deleted from the main window
// (already imported), the DB row's message_id_header is the fallback.
// ---------------------------------------------------------------------------

const appendedDraftMsgIds = new Map<string, string>();

export function registerAppendedDraftMsgId(draftId: string, msgId: string | null): void {
  if (!msgId) return;
  appendedDraftMsgIds.set(draftId, msgId);
  // Composer sessions append a handful of copies; keep the map bounded anyway.
  if (appendedDraftMsgIds.size > 100) {
    const firstKey = appendedDraftMsgIds.keys().next().value;
    if (firstKey !== undefined) appendedDraftMsgIds.delete(firstKey);
  }
}

export function getAppendedDraftMsgId(draftId: string): string | null {
  return appendedDraftMsgIds.get(draftId) ?? null;
}

/**
 * Extract the RFC Message-ID from a base64url-encoded raw email, normalized to
 * the bracket-less form stored in messages.message_id_header (Rust mail-parser
 * strips angle brackets).
 */
export function extractRfcMessageId(rawBase64Url: string): string | null {
  try {
    let b64 = rawBase64Url.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const raw = atob(b64);
    const match = raw.match(/^message-id:\s*<?([^>\r\n]+)>?/im);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Record that the draft copy carrying this Message-ID must not survive: if a
 * sync (re-)imports an is_draft row with it, the sweep deletes it locally and
 * from the server at its then-current UID.
 */
export async function recordDraftKill(
  accountId: string,
  messageIdHeader: string | null,
): Promise<void> {
  if (!messageIdHeader) return;
  // Normalize like Rust's normalize_message_id: trim + strip angle brackets.
  const normalized = messageIdHeader.trim().replace(/^</, "").replace(/>$/, "").trim();
  if (!normalized) return;
  const db = await getDb();
  await db.execute(
    `INSERT OR REPLACE INTO draft_kill_list (account_id, message_id_header, created_at)
     VALUES ($1, $2, unixepoch())`,
    [accountId, normalized],
  );
}

/** Prune kill entries past their TTL — a copy that never resurfaced is gone for good. */
export async function pruneDraftKillList(): Promise<void> {
  const db = await getDb();
  const cutoff = Math.floor(Date.now() / 1000) - KILL_LIST_TTL_DAYS * 86400;
  await db.execute(`DELETE FROM draft_kill_list WHERE created_at < $1`, [cutoff]);
}
