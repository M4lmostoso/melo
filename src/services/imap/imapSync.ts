import type { ImapConfig, ImapSyncHeader, ImapThreadUpdate, DeltaCheckRequest, DeltaCheckResult } from "./tauriCommands";
import {
  imapListFolders,
  imapGetFolderStatus,
  imapFetchAndStore,
  imapStoreThreads,
  imapFetchNewUids,
  imapSearchFolder,
  imapSearchAllUids,
  imapRawSearchAllUids,
  imapCheckSeenUids,
  imapDeltaCheck,
} from "./tauriCommands";
import { buildImapConfig } from "./imapConfigBuilder";
import {
  mapFolderToLabel,
  syncFoldersToLabels,
  getSyncableFolders,
} from "./folderMapper";
import type { ParsedMessage } from "../gmail/messageParser";
import type { SyncResult } from "../email/types";
import { deleteMessagesForFolder, purgeImapDuplicates, purgeOrphanPlaceholderThreads } from "../db/messages";
import { getAccount, updateAccountSyncState } from "../db/accounts";
import {
  upsertFolderSyncState,
  getAllFolderSyncStates,
  type FolderSyncState,
} from "../db/folderSyncState";
import { clearDeletedImapUidsForFolder, pruneDeletedImapUids, getDeletedImapUidsForFolder } from "../db/deletedImapUids";
import { getLabelsForAccount } from "../db/labels";
import { reconcilePecReceipts } from "../pec/pecManager";
import {
  buildThreads,
  normalizeSubject,
  parseReferences,
  type ThreadableMessage,
  type ThreadGroup,
} from "../threading/threadBuilder";
import { getThreadSubjectMap } from "../db/threads";
import { getPendingOpResourceIds } from "../db/pendingOperations";
import { applyPendingLabelAssignments } from "../db/pendingLabelAssignments";
import { processThreadUrgency, type ThreadUrgencyParams } from "@/services/ai/urgencyPipeline";
import { getSetting } from "../db/settings";
import {
  getSkippedUidsForFolder,
  recordUnfetchableAttempts,
  recordDuplicateUids,
  clearUnfetchableUids,
  pruneGoneUnfetchableUids,
  getUnfetchableCountForAccount,
  getUnfetchableMaxRetries,
} from "../db/unfetchableUids";
import { getVipSenders } from "../db/notificationVips";
import { getThreadCategory } from "../db/threadCategories";
import { shouldNotifyForMessage, queueNewEmailNotification, logNotificationSuppressed } from "../notifications/notificationManager";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Messages per IMAP fetch batch.
 * Each call to imap_fetch_and_store transmits only ~200 bytes per message back to
 * TypeScript regardless of body size — bodies go directly Rust → SQLite.
 */
const BATCH_SIZE = 25;
/**
 * How many delta sync cycles between expensive maintenance operations.
 * Every 10 cycles ≈ every ~10 minutes at the default 60 s interval.
 */
const MAINTENANCE_EVERY_N_CYCLES = 10;

/** Per-account delta sync cycle counters for throttling maintenance work. */
const _deltaSyncCycleCount = new Map<string, number>();


// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_DELAY_MS = 15_000;
const CIRCUIT_BREAKER_MAX_FAILURES = 5;
const INTER_FOLDER_DELAY_MS = 1_000;

export function isConnectionError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return (
    msg.includes("timed out") ||
    msg.includes("connection") ||
    msg.includes("tcp") ||
    msg.includes("tls") ||
    msg.includes("dns") ||
    msg.includes("econnrefused") ||
    msg.includes("network") ||
    msg.includes("socket")
  );
}

/**
 * True when an error means the server cannot serve THIS specific message
 * (as opposed to a transient connection problem affecting the whole batch).
 * The prime example is DavMail/Exchange streaming a message body then hanging:
 * the Rust fetch now caps that with an idle-timeout and surfaces "literal
 * stalled". Such a UID must be skipped so it does not block the rest of the
 * folder forever — unlike a connection error, retrying it never helps.
 */
export function isUnfetchableMessageError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return (
    msg.includes("literal stalled") ||
    msg.includes("mid-literal") ||
    msg.includes("read literal")
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// IMAP SINCE date helpers
// ---------------------------------------------------------------------------

const IMAP_MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

export function formatImapDate(date: Date): string {
  const day = date.getUTCDate();
  const month = IMAP_MONTH_NAMES[date.getUTCMonth()];
  const year = date.getUTCFullYear();
  return `${day}-${month}-${year}`;
}

export function computeSinceDate(daysBack: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysBack - 1);
  return formatImapDate(date);
}

// ---------------------------------------------------------------------------
// Progress reporting
// ---------------------------------------------------------------------------

export interface ImapSyncProgress {
  phase: "folders" | "messages" | "threading" | "storing_threads" | "done";
  current: number;
  total: number;
  folder?: string;
}

export type ImapSyncProgressCallback = (progress: ImapSyncProgress) => void;

// ---------------------------------------------------------------------------
// Threading helpers
// ---------------------------------------------------------------------------

/**
 * Convert an ImapSyncHeader (already in DB) to a ThreadableMessage for JWZ.
 */
function headerToThreadable(h: ImapSyncHeader): ThreadableMessage {
  return {
    id: h.local_id,
    messageId: h.message_id ?? `synthetic-${h.local_id}@melo.local`,
    inReplyTo: h.in_reply_to,
    references: h.references,
    subject: h.subject,
    date: h.date,
  };
}

/**
 * Compute the final label set for a thread group given the member ImapSyncHeaders
 * and the cross-folder RFC-ID → labels accumulation map.
 *
 * threadHasExternalSenders: true when the DB already contains messages from other
 * senders in this thread (e.g. original inbox messages when syncing a sent reply).
 * Prevents the thread from losing its INBOX label after a reply is stored.
 */
export function computeThreadLabels(
  messages: ImapSyncHeader[],
  labelsByRfcId: Map<string, Set<string>>,
  accountEmail: string,
  threadHasExternalSenders: boolean,
): string[] {
  const allLabels = new Set<string>();
  const lowerAccountEmail = accountEmail.toLowerCase();

  for (const msg of messages) {
    // Non-INBOX/SENT folder labels (TRASH, SPAM, DRAFT, ARCHIVE, user folders)
    if (msg.label_id !== "INBOX" && msg.label_id !== "SENT") {
      allLabels.add(msg.label_id);
    }
    // Pseudo-labels. UNREAD only from live messages — an unread message in
    // Trash/Spam must not flag the whole thread as unread.
    if (!msg.is_read && msg.label_id !== "TRASH" && msg.label_id !== "SPAM") allLabels.add("UNREAD");
    if (msg.is_starred) allLabels.add("STARRED");
    if (msg.is_draft) allLabels.add("DRAFT");
    // Cross-folder labels — only non-INBOX/SENT system/user labels
    if (msg.message_id) {
      const extra = labelsByRfcId.get(msg.message_id);
      if (extra) {
        for (const lid of extra) {
          if (lid === "INBOX" || lid === "SENT" || lid === "UNREAD" || lid === "STARRED" || lid === "DRAFT") continue;
          allLabels.add(lid);
        }
      }
    }
  }

  // messages are already sorted by date ascending (caller guarantees this)
  const last = messages[messages.length - 1]!;
  const isFromMe = (addr: string | null) =>
    !!addr && addr.toLowerCase() === lowerAccountEmail;

  // SENT: last message in the thread was sent by me
  if (isFromMe(last.from_address)) {
    allLabels.add("SENT");
  }

  // INBOX: at least one non-trash/spam message in the thread is from someone else,
  // either in this sync batch or already stored in the DB (threadHasExternalSenders).
  const newBatchHasExternal = messages.some(
    (m) => !isFromMe(m.from_address) && m.label_id !== "TRASH" && m.label_id !== "SPAM",
  );

  // Only treat TRASH/SPAM as "moving to trash" when an external-sender message is
  // the one being trashed. Self-sent messages in TRASH (e.g. a draft the IMAP server
  // moved to Trash instead of expunging on deletion) must not suppress INBOX or
  // give the thread a TRASH label — otherwise a deleted draft contaminates the
  // inbox conversation it was part of.
  const hasExternalInTrash = messages.some(
    (m) => (m.label_id === "TRASH" || m.label_id === "SPAM") && !isFromMe(m.from_address),
  );
  if (!hasExternalInTrash) {
    allLabels.delete("TRASH");
    allLabels.delete("SPAM");
  }
  const movingToTrashOrSpam = hasExternalInTrash;
  if ((newBatchHasExternal || threadHasExternalSenders) && !movingToTrashOrSpam) {
    allLabels.add("INBOX");
  }

  return [...allLabels];
}

/**
 * Before subject-based merging, look up existing DB threads by In-Reply-To /
 * References RFC Message-IDs of the newly stored messages.
 * This correctly threads a sent reply into the original conversation even when
 * the IMAP server did not return APPENDUID (uid === 0) so the local optimistic
 * save was skipped and the reply arrives via delta sync as a new message.
 */
async function mergeGroupsByRfcId(
  accountId: string,
  groups: ThreadGroup[],
  headerById: Map<string, ImapSyncHeader>,
): Promise<ThreadGroup[]> {
  // Collect all RFC Message-IDs referenced by newly stored messages
  const allRefIds: string[] = [];
  for (const group of groups) {
    for (const msgId of group.messageIds) {
      const header = headerById.get(msgId);
      if (!header?.stored) continue;
      if (header.in_reply_to) {
        // Extract bare ID from optional angle brackets
        const m = header.in_reply_to.match(/<([^>]+)>/);
        allRefIds.push(m ? m[1]! : header.in_reply_to.trim());
      }
      if (header.references) {
        allRefIds.push(...parseReferences(header.references));
      }
    }
  }
  if (allRefIds.length === 0) return groups;

  const unique = [...new Set(allRefIds.filter(Boolean))];
  const { getDb } = await import("../db/connection");
  const db = await getDb();

  // Map each referenced RFC Message-ID → thread_id already in DB.
  // When multiple rows share the same message_id_header (APPENDUID mismatch
  // created a duplicate), prefer the thread that is not a per-message
  // placeholder (imap-{accountId}-{folder}-{uid}) so replies end up in the
  // correct conversation thread rather than an ephemeral placeholder.
  const rfcToThreadId = new Map<string, string>();
  const batchSize = 100;
  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize);
    const placeholders = batch.map((_, j) => `$${j + 2}`).join(",");
    const rows = await db.select<{ message_id_header: string; thread_id: string }[]>(
      `SELECT message_id_header, thread_id FROM messages WHERE account_id = $1 AND message_id_header IN (${placeholders})`,
      [accountId, ...batch],
    );
    for (const row of rows) {
      if (!row.message_id_header || !row.thread_id) continue;
      const existing = rfcToThreadId.get(row.message_id_header);
      if (!existing) {
        rfcToThreadId.set(row.message_id_header, row.thread_id);
      } else {
        // When duplicates exist (APPENDUID mismatch), prefer the non-placeholder
        // thread_id. Placeholder IDs start with imap-{accountId}-{folder}-{uid};
        // algorithm-created threads start with imap-thread-* or have no imap prefix.
        const placeholderPrefix = `imap-${accountId}-`;
        const existingIsPlaceholder = existing.startsWith(placeholderPrefix);
        const newIsPlaceholder = row.thread_id.startsWith(placeholderPrefix);
        if (existingIsPlaceholder && !newIsPlaceholder) {
          rfcToThreadId.set(row.message_id_header, row.thread_id);
        }
      }
    }
  }
  if (rfcToThreadId.size === 0) return groups;

  // Remap any group whose messages reference an existing thread
  const remapped = new Map<string, string>(); // placeholder thread_id → existing thread_id
  for (const group of groups) {
    outer: for (const msgId of group.messageIds) {
      const header = headerById.get(msgId);
      if (!header?.stored) continue;
      const refs: string[] = [];
      if (header.in_reply_to) {
        const m = header.in_reply_to.match(/<([^>]+)>/);
        refs.push(m ? m[1]! : header.in_reply_to.trim());
      }
      if (header.references) refs.push(...parseReferences(header.references));
      for (const ref of refs) {
        const existingThreadId = rfcToThreadId.get(ref);
        if (existingThreadId && existingThreadId !== group.threadId) {
          remapped.set(group.threadId, existingThreadId);
          break outer;
        }
      }
    }
  }
  if (remapped.size === 0) return groups;

  const merged = new Map<string, string[]>();
  for (const group of groups) {
    const targetId = remapped.get(group.threadId) ?? group.threadId;
    const existing = merged.get(targetId);
    if (existing) {
      for (const id of group.messageIds) {
        if (!existing.includes(id)) existing.push(id);
      }
    } else {
      merged.set(targetId, [...group.messageIds]);
    }
  }
  return [...merged.entries()].map(([threadId, messageIds]) => ({ threadId, messageIds }));
}

/**
 * After JWZ threading, check if any new thread group can be merged into an existing
 * DB thread via normalized subject. This handles forwards and replies that lack
 * In-Reply-To/References headers — their only linkage to the original conversation
 * is the normalized subject (Fwd:/Re:/R: stripped).
 *
 * Only new groups (those whose threadId doesn't yet exist in the DB subject map keys)
 * are candidates. Groups whose subject matches an existing thread are remapped to that
 * thread's ID so imap_store_threads writes the new messages into the right thread.
 */
async function mergeGroupsBySubject(
  accountId: string,
  groups: ThreadGroup[],
  threadableMessages: ThreadableMessage[],
): Promise<ThreadGroup[]> {
  // Build a quick lookup: local message ID → subject
  const subjectById = new Map<string, string | null>();
  for (const m of threadableMessages) {
    subjectById.set(m.id, m.subject);
  }

  // Collect normalized subjects that appear to be replies/forwards.
  // We only look up existing threads when the new message has a prefix, because
  // a bare subject could collide with an unrelated thread.
  const candidateGroups: ThreadGroup[] = [];
  for (const group of groups) {
    const firstSubject = group.messageIds
      .map((id) => subjectById.get(id) ?? null)
      .find((s) => s !== null && s !== undefined) ?? null;
    if (!firstSubject) continue;
    const norm = normalizeSubject(firstSubject);
    // Only candidate if original subject had a strippable prefix (i.e. it's a reply/fwd)
    if (norm && normalizeSubject(norm) === norm && firstSubject.trim() !== norm) {
      candidateGroups.push(group);
    }
  }

  if (candidateGroups.length === 0) return groups;

  const existingSubjectMap = await getThreadSubjectMap(accountId);

  const remapped = new Map<string, string>(); // oldThreadId → existingThreadId
  for (const group of candidateGroups) {
    const firstSubject = group.messageIds
      .map((id) => subjectById.get(id) ?? null)
      .find((s) => s !== null && s !== undefined) ?? null;
    if (!firstSubject) continue;
    const norm = normalizeSubject(firstSubject);
    const existingId = existingSubjectMap.get(norm);
    if (existingId && existingId !== group.threadId) {
      remapped.set(group.threadId, existingId);
    }
  }

  if (remapped.size === 0) return groups;

  // Merge remapped groups: messages with the same target threadId get combined
  const merged = new Map<string, string[]>(); // targetThreadId → messageIds
  const processed = new Set<string>();

  for (const group of groups) {
    const targetId = remapped.get(group.threadId) ?? group.threadId;
    const existing = merged.get(targetId);
    if (existing) {
      for (const id of group.messageIds) {
        if (!existing.includes(id)) existing.push(id);
      }
    } else {
      merged.set(targetId, [...group.messageIds]);
    }
    processed.add(group.threadId);
  }

  return [...merged.entries()].map(([threadId, messageIds]) => ({ threadId, messageIds }));
}

/**
 * Build ImapThreadUpdate records from thread groups and stored headers.
 * Called after JWZ threading to produce the payload for imap_store_threads.
 */
/**
 * Returns the set of thread IDs (from the given list) that have at least one
 * message in the DB from a sender other than this account, and are not currently
 * labelled TRASH or SPAM. Used to preserve INBOX when syncing a sent reply.
 */
async function getThreadsWithExternalSenders(
  accountId: string,
  accountEmail: string,
  threadIds: string[],
): Promise<Set<string>> {
  if (threadIds.length === 0) return new Set();
  const { getDb } = await import("../db/connection");
  const db = await getDb();
  const ph = threadIds.map((_, i) => `$${i + 3}`).join(",");
  const rows = await db.select<{ thread_id: string }[]>(
    `SELECT DISTINCT m.thread_id
     FROM messages m
     WHERE m.account_id = $1
       AND lower(m.from_address) != lower($2)
       AND m.thread_id IN (${ph})
       AND NOT EXISTS (
         SELECT 1 FROM thread_labels tl
         WHERE tl.account_id = $1 AND tl.thread_id = m.thread_id
           AND tl.label_id IN ('TRASH', 'SPAM')
       )`,
    [accountId, accountEmail, ...threadIds],
  );
  return new Set(rows.map((r) => r.thread_id));
}

function buildThreadUpdates(
  threadGroups: ThreadGroup[],
  headerById: Map<string, ImapSyncHeader>,
  labelsByRfcId: Map<string, Set<string>>,
  skipThreadIds: Set<string>,
  accountEmail: string,
  threadsWithExternalSenders: Set<string>,
): { updates: ImapThreadUpdate[]; urgencyQueue: ThreadUrgencyParams[] } {
  const updates: ImapThreadUpdate[] = [];
  const urgencyQueue: ThreadUrgencyParams[] = [];

  for (const group of threadGroups) {
    if (skipThreadIds.has(group.threadId)) continue;

    const messages = group.messageIds
      .map((id) => headerById.get(id))
      .filter((h): h is ImapSyncHeader => h !== undefined && h.stored);

    if (messages.length === 0) continue;
    messages.sort((a, b) => a.date - b.date);

    const first = messages[0]!;
    const last = messages[messages.length - 1]!;

    // Read state only counts live messages: an unread message in Trash/Spam
    // must not mark the thread unread in the Inbox (every() on an all-trashed
    // group is vacuously true, matching recalculateThreadStats' COALESCE(…, 1)).
    const isRead = messages
      .filter((m) => m.label_id !== "TRASH" && m.label_id !== "SPAM")
      .every((m) => m.is_read);
    const isStarred = messages.some((m) => m.is_starred);
    const hasAttachments = messages.some((m) => m.has_attachments);
    const labelIds = computeThreadLabels(messages, labelsByRfcId, accountEmail, threadsWithExternalSenders.has(group.threadId));

    updates.push({
      thread_id: group.threadId,
      message_ids: group.messageIds,
      subject: first.subject,
      snippet: last.snippet,
      last_message_at: last.date,
      is_read: isRead,
      is_starred: isStarred,
      has_attachments: hasAttachments,
      label_ids: labelIds,
    });

    urgencyQueue.push({
      accountId: "", // filled in by caller
      threadId: group.threadId,
      subject: first.subject,
      bodyText: last.snippet,
      fromAddress: last.from_address,
      fromName: last.from_name,
      lastMessageAt: last.date,
      labelIds,
    });
  }

  return { updates, urgencyQueue };
}

// ---------------------------------------------------------------------------
// Additions reconciliation (self-healing)
// ---------------------------------------------------------------------------

/**
 * Enumerate a folder authoritatively with `UID SEARCH NOT DELETED` (which
 * DavMail/Exchange honour, unlike the open-ended `n:*` range the delta path
 * uses) and fetch exactly the UIDs missing from the local DB. Used both for a
 * forced full (re)sync (cursor reset to 0) and as a periodic self-healing pass
 * so ongoing sync can never silently drift behind the server.
 *
 * Returns null when the server returns an empty/failed enumeration — the caller
 * must NOT advance the cursor in that case (it is treated as a transient hiccup,
 * never a mass purge). Otherwise returns the fetched headers, the server's max
 * UID, and how many messages the server refused to serve (still missing after a
 * clean fetch — surfaced as sync-health, never silent).
 */
async function reconcileFolderAdditions(
  config: ImapConfig,
  accountId: string,
  folderPath: string,
  labelId: string,
  maxRetries: number,
): Promise<{ headers: ImapSyncHeader[]; serverMaxUid: number; unfetchable: number } | null> {
  // Enumerate over a fresh raw connection: the pooled async-imap UID SEARCH can
  // silently return a truncated set on DavMail/Exchange, which would hide
  // messages from this diff forever. Fall back to the pooled search only if the
  // raw path errors.
  let serverUids: number[];
  try {
    serverUids = await imapRawSearchAllUids(config, folderPath);
  } catch (err) {
    console.warn(`[imapSync] raw enumeration failed for ${folderPath}, falling back to pooled search:`, err);
    serverUids = await imapSearchAllUids(config, folderPath);
  }
  if (serverUids.length === 0) return null;

  const serverMaxUid = serverUids.reduce((m, u) => (u > m ? u : m), 0);
  const { getStoredImapUidsForFolder } = await import("../db/messages");
  const stored = new Set(
    (await getStoredImapUidsForFolder(accountId, folderPath)).map((r) => r.uid),
  );
  const tomb = await getDeletedImapUidsForFolder(accountId, folderPath);
  // UIDs already retried past the cap: the server keeps listing them but never
  // serves them. Skip them so we don't re-grind the same failures every cycle.
  const skipped = await getSkippedUidsForFolder(accountId, folderPath, maxRetries);
  // A skip-listed UID is permanently excluded from `missing` below, so it can
  // never be re-fetched to self-clear. If it's no longer on the server at all
  // (deleted/moved since the failure was recorded), prune it now instead of
  // leaving a zombie entry that inflates the unfetchable count forever.
  const serverUidSet = new Set(serverUids);
  const goneUids = [...skipped].filter((u) => !serverUidSet.has(u));
  await pruneGoneUnfetchableUids(accountId, folderPath, goneUids).catch(() => {});
  const missing = serverUids
    .filter((u) => !stored.has(u) && !tomb.has(u) && !skipped.has(u))
    .sort((a, b) => a - b);

  let headers: ImapSyncHeader[] = [];
  let unfetchable = 0;
  if (missing.length > 0) {
    ({ headers } = await fetchAllInBatches(config, accountId, folderPath, labelId, missing, 0));
    const storedAfter = new Set(
      (await getStoredImapUidsForFolder(accountId, folderPath)).map((r) => r.uid),
    );
    // A UID the server returned but the store layer didn't persist for this
    // folder is a cross-folder duplicate (same RFC Message-ID already stored
    // elsewhere — Filter 2 in imap_fetch_and_store). The server serves it
    // fine, so it must never count as unfetchable; record it as a known
    // duplicate so the next reconcile stops re-downloading its full body.
    const returnedUids = new Set(headers.map((h) => h.uid));
    const stillMissing = missing.filter((u) => !storedAfter.has(u) && !returnedUids.has(u));
    const duplicates = missing.filter((u) => !storedAfter.has(u) && returnedUids.has(u));
    const nowFetched = missing.filter((u) => storedAfter.has(u));
    unfetchable = stillMissing.length;
    // Count another failed attempt for the ones still missing; clear any that
    // finally came through so a transient failure doesn't count against them.
    await recordUnfetchableAttempts(accountId, folderPath, stillMissing).catch(() => {});
    await clearUnfetchableUids(accountId, folderPath, nowFetched).catch(() => {});
    await recordDuplicateUids(accountId, folderPath, duplicates).catch(() => {});
    if (stillMissing.length > 0) {
      console.warn(
        `[imapSync] ${folderPath}: ${stillMissing.length}/${missing.length} message(s) could NOT be fetched (server won't serve their bodies) — UIDs ${stillMissing.slice(0, 30).join(",")}${stillMissing.length > 30 ? "…" : ""}`,
      );
    }
    if (duplicates.length > 0) {
      console.log(
        `[imapSync] ${folderPath}: ${duplicates.length} message(s) are cross-folder duplicates (already stored under another folder) — skip-listed as 'duplicate'`,
      );
    }
  }
  return { headers, serverMaxUid, unfetchable };
}

// ---------------------------------------------------------------------------
// Deletion reconciliation
// ---------------------------------------------------------------------------

export async function reconcileDeletedMessages(
  config: ImapConfig,
  accountId: string,
  folderPath: string,
): Promise<void> {
  const { getStoredImapUidsForFolder } = await import("../db/messages");
  const stored = await getStoredImapUidsForFolder(accountId, folderPath);
  if (stored.length === 0) return;

  // Use the authoritative raw enumeration: a truncated pooled search here would
  // wrongly flag present messages as deleted and purge them (and fight the
  // additions reconcile, which also uses the raw search).
  let serverUids: number[];
  try {
    serverUids = await imapRawSearchAllUids(config, folderPath);
  } catch {
    try {
      serverUids = await imapSearchAllUids(config, folderPath);
    } catch {
      return;
    }
  }

  // SAFETY GUARD: never mass-delete on an empty server result.
  // Some servers (and flaky/rate-limited connections) return an empty UID SEARCH
  // even though the folder is full — the same "returns empty despite valid UIDs"
  // quirk documented for UID FETCH in the Rust client. Without this guard, an empty
  // result makes EVERY locally stored message look "deleted on the server" and wipes
  // the whole folder from the DB (this is what nuked thousands of messages). A real
  // empty folder is harmless to skip: there is nothing new to reconcile, and any
  // genuine deletions are caught on a later cycle once the search returns properly.
  if (serverUids.length === 0) {
    console.warn(
      `[imapSync] Reconciliation: server returned 0 UIDs for ${folderPath} but ${stored.length} message(s) are stored locally — skipping deletion (treating as a failed/empty search, not a mass purge).`,
    );
    return;
  }

  const serverSet = new Set(serverUids);
  const orphans = stored.filter((row) => !serverSet.has(row.uid));
  if (orphans.length === 0) return;

  console.log(`[imapSync] Reconciliation: removing ${orphans.length} message(s) deleted externally in ${folderPath}`);

  const orphanIds = orphans.map((o) => o.id);
  const { getDb, executeAtomicBatch } = await import("../db/connection");
  const db = await getDb();

  // Each chunk's deletes across message_embeddings/messages/thread_labels/threads
  // run inside ONE real SQLite transaction (Rust-side): a crash mid-chunk can no
  // longer leave orphaned thread rows or stale counts. Chunked to stay under
  // SQLite's 999-variable limit (chunk + affected-thread ids share one query).
  const CHUNK = 400;
  for (let i = 0; i < orphanIds.length; i += CHUNK) {
    const chunk = orphanIds.slice(i, i + CHUNK);
    const ph = chunk.map((_, j) => `$${j + 2}`).join(",");

    // Collect thread IDs before deleting (needed for orphan-thread cleanup)
    const threadRows = await db.select<{ thread_id: string }[]>(
      `SELECT DISTINCT thread_id FROM messages WHERE account_id = $1 AND id IN (${ph})`,
      [accountId, ...chunk],
    );
    const affectedThreadIds = threadRows.map((r) => r.thread_id);

    // Compute which affected threads survive the deletion BEFORE running it, so
    // the whole write set can be a single atomic batch.
    let emptyThreadIds: string[] = [];
    let survivingIds: string[] = [];
    if (affectedThreadIds.length > 0) {
      const tph = affectedThreadIds.map((_, j) => `$${j + 2}`).join(",");
      const mph = chunk.map((_, j) => `$${j + 2 + affectedThreadIds.length}`).join(",");
      const surviving = await db.select<{ thread_id: string }[]>(
        `SELECT DISTINCT thread_id FROM messages
         WHERE account_id = $1 AND thread_id IN (${tph}) AND id NOT IN (${mph})`,
        [accountId, ...affectedThreadIds, ...chunk],
      );
      const survivingSet = new Set(surviving.map((r) => r.thread_id));
      emptyThreadIds = affectedThreadIds.filter((id) => !survivingSet.has(id));
      survivingIds = affectedThreadIds.filter((id) => survivingSet.has(id));
    }

    // ?N-style placeholders — executeAtomicBatch goes through rusqlite, not the plugin.
    const qph = chunk.map((_, j) => `?${j + 2}`).join(",");
    const statements = [
      {
        sql: `DELETE FROM message_embeddings WHERE account_id = ?1 AND message_id IN (${qph})`,
        params: [accountId, ...chunk],
      },
      {
        sql: `DELETE FROM messages WHERE account_id = ?1 AND id IN (${qph})`,
        params: [accountId, ...chunk],
      },
    ];
    if (emptyThreadIds.length > 0) {
      const eph = emptyThreadIds.map((_, j) => `?${j + 2}`).join(",");
      statements.push(
        {
          sql: `DELETE FROM thread_labels WHERE account_id = ?1 AND thread_id IN (${eph})`,
          params: [accountId, ...emptyThreadIds],
        },
        {
          sql: `DELETE FROM threads WHERE account_id = ?1 AND id IN (${eph})`,
          params: [accountId, ...emptyThreadIds],
        },
      );
    }
    if (survivingIds.length > 0) {
      // Recompute the thread's derived flags inside the same transaction
      // (post-delete view). message_count alone is NOT enough: if the removed
      // message was the unread one, a message_count-only update leaves is_read=0
      // stale on a thread whose remaining messages are all read — producing a
      // phantom Inbox/badge count that no message backs (the "unread" smart
      // folder, which counts messages, shows 0). Mirror recalculateThreadStats
      // step 1 for every pure-SQL flag so the thread row stays consistent with
      // its surviving messages atomically.
      const sph = survivingIds.map((_, j) => `?${j + 2}`).join(",");
      statements.push({
        sql: `UPDATE threads
              SET is_read = COALESCE((SELECT MIN(is_read) FROM messages WHERE account_id = threads.account_id AND thread_id = threads.id AND is_draft = 0 AND is_trashed = 0), 1),
                  is_starred = COALESCE((SELECT MAX(is_starred) FROM messages WHERE account_id = threads.account_id AND thread_id = threads.id AND is_trashed = 0), 0),
                  has_attachments = CASE WHEN EXISTS(SELECT 1 FROM attachments a JOIN messages m ON a.message_id = m.id WHERE m.account_id = threads.account_id AND m.thread_id = threads.id AND m.is_trashed = 0 AND a.is_inline = 0 AND a.content_id IS NULL) THEN 1 ELSE 0 END,
                  message_count = (SELECT COUNT(*) FROM messages WHERE account_id = threads.account_id AND thread_id = threads.id AND is_draft = 0 AND is_trashed = 0),
                  last_message_at = COALESCE((SELECT MAX(date) FROM messages WHERE account_id = threads.account_id AND thread_id = threads.id AND is_trashed = 0), threads.last_message_at),
                  snippet = COALESCE((SELECT snippet FROM messages WHERE account_id = threads.account_id AND thread_id = threads.id AND is_draft = 0 AND is_trashed = 0 ORDER BY date DESC LIMIT 1), threads.snippet),
                  subject = COALESCE((SELECT subject FROM messages WHERE account_id = threads.account_id AND thread_id = threads.id AND is_draft = 0 AND is_trashed = 0 ORDER BY date DESC LIMIT 1), threads.subject)
              WHERE account_id = ?1 AND id IN (${sph})`,
        params: [accountId, ...survivingIds],
      });
    }
    await executeAtomicBatch(statements);
  }
}

// ---------------------------------------------------------------------------
// Flag reconciliation — mark locally-unread messages as read when server says SEEN
// ---------------------------------------------------------------------------

async function syncReadFlagsForFolder(
  config: ImapConfig,
  accountId: string,
  folderPath: string,
): Promise<number> {
  const { getDb } = await import("../db/connection");
  const db = await getDb();

  // Fetch all locally-unread UIDs for this folder
  const rows = await db.select<{ id: string; uid: number; thread_id: string }[]>(
    `SELECT id, imap_uid as uid, thread_id FROM messages
     WHERE account_id = $1 AND imap_folder = $2 AND imap_uid IS NOT NULL AND is_read = 0`,
    [accountId, folderPath],
  );
  if (rows.length === 0) return 0;

  // Ask the server which of those UIDs have \Seen set
  let seenUids: number[];
  try {
    seenUids = await imapCheckSeenUids(config, folderPath, rows.map((r) => r.uid));
  } catch {
    return 0;
  }
  if (seenUids.length === 0) return 0;

  const seenSet = new Set(seenUids);
  const toMark = rows.filter((r) => seenSet.has(r.uid));
  if (toMark.length === 0) return 0;

  console.log(`[imapSync] syncReadFlags: marking ${toMark.length} message(s) as read in ${folderPath}`);

  const CHUNK = 500;
  const affectedThreadIds = [...new Set(toMark.map((r) => r.thread_id))];

  for (let i = 0; i < toMark.length; i += CHUNK) {
    const chunk = toMark.slice(i, i + CHUNK);
    const ph = chunk.map((_, j) => `$${j + 2}`).join(",");
    await db.execute(
      `UPDATE messages SET is_read = 1 WHERE account_id = $1 AND id IN (${ph})`,
      [accountId, ...chunk.map((r) => r.id)],
    );
  }

  // Update thread read state: mark thread as read only if no unread messages remain
  for (let i = 0; i < affectedThreadIds.length; i += CHUNK) {
    const chunk = affectedThreadIds.slice(i, i + CHUNK);
    const tph = chunk.map((_, j) => `$${j + 2}`).join(",");
    await db.execute(
      `UPDATE threads SET is_read = 1
       WHERE account_id = $1 AND id IN (${tph})
         AND NOT EXISTS (
           SELECT 1 FROM messages
           WHERE messages.account_id = $1 AND messages.thread_id = threads.id
             AND messages.is_read = 0 AND messages.is_draft = 0 AND messages.is_trashed = 0
         )`,
      [accountId, ...chunk],
    );
  }

  return toMark.length;
}

// ---------------------------------------------------------------------------
// Fetch + store in batches
// ---------------------------------------------------------------------------

/**
 * Fetch a batch of UIDs using imap_fetch_and_store.
 * Falls back to two half-batches on connection errors.
 */
async function fetchAndStoreWithRetry(
  config: ImapConfig,
  accountId: string,
  folder: string,
  labelId: string,
  uids: number[],
  cutoffDate: number,
): Promise<ImapSyncHeader[]> {
  try {
    return await imapFetchAndStore(config, accountId, folder, labelId, uids, cutoffDate);
  } catch (err) {
    // Single UID failed: decide whether it's a poison message to skip or a
    // transient error to retry later.
    if (uids.length <= 1) {
      if (isUnfetchableMessageError(err)) {
        // The server cannot serve this message's body (DavMail hang etc.).
        // Skip it so it never blocks the rest of the folder. Returning [] lets
        // lastUid advance past it — it will not be retried every cycle.
        console.warn(`[imapSync] Skipping unfetchable UID ${uids[0]} in ${folder}: ${String(err)}`);
        return [];
      }
      // Transient (connection) error — rethrow so the folder cursor does not
      // advance and the UID is retried on the next sync.
      throw err;
    }

    // Multiple UIDs: a single poison message would otherwise take the whole
    // batch down, losing its healthy neighbours. Split and recurse to isolate
    // the offending UID(s); only the truly-unfetchable ones are dropped.
    const half = Math.ceil(uids.length / 2);
    console.warn(`[imapSync] FETCH failed for ${uids.length} UIDs in ${folder} — isolating as ${half}+${uids.length - half}`);
    await delay(500);

    const headers: ImapSyncHeader[] = [];
    let transientErr: unknown;
    for (const sub of [uids.slice(0, half), uids.slice(half)]) {
      try {
        headers.push(...(await fetchAndStoreWithRetry(config, accountId, folder, labelId, sub, cutoffDate)));
      } catch (subErr) {
        // A connection error bubbled up from a sub-batch. Remember it so we
        // don't advance the cursor past UIDs we never actually fetched.
        transientErr = transientErr ?? subErr;
        console.warn(
          `[imapSync] Sub-batch FETCH failed for UIDs ${sub[0]}–${sub[sub.length - 1]} in ${folder} — will be retried next delta sync`,
          subErr,
        );
      }
    }
    if (transientErr) throw transientErr;
    return headers;
  }
}

/**
 * Fetch and store all UIDs in BATCH_SIZE chunks.
 * Returns all ImapSyncHeaders (stored + skipped-duplicates) and the highest UID seen.
 */
async function fetchAllInBatches(
  config: ImapConfig,
  accountId: string,
  folder: string,
  labelId: string,
  uids: number[],
  cutoffDate: number,
  onProgress?: (fetched: number, total: number) => void,
): Promise<{ headers: ImapSyncHeader[]; lastUid: number }> {
  const headers: ImapSyncHeader[] = [];
  // Track the highest UID actually returned by the server, not the highest
  // requested. If a batch (or sub-batch) fails, we don't advance lastUid past
  // the failed messages so the next delta sync retries them.
  let lastUid = 0;

  for (let i = 0; i < uids.length; i += BATCH_SIZE) {
    const batch = uids.slice(i, i + BATCH_SIZE);
    const batchHeaders = await fetchAndStoreWithRetry(
      config, accountId, folder, labelId, batch, cutoffDate,
    );
    headers.push(...batchHeaders);
    // Advance lastUid only for UIDs the server actually returned (tombstoned
    // messages are absent from batchHeaders but re-filtered harmlessly next sync).
    for (const h of batchHeaders) {
      if (h.uid > lastUid) lastUid = h.uid;
    }
    onProgress?.(Math.min(i + BATCH_SIZE, uids.length), uids.length);
    await delay(0);
  }

  return { headers, lastUid };
}

// ---------------------------------------------------------------------------
// Initial sync
// ---------------------------------------------------------------------------

export async function imapInitialSync(
  accountId: string,
  daysBack = 365,
  onProgress?: ImapSyncProgressCallback,
): Promise<SyncResult> {
  const account = await getAccount(accountId);
  if (!account) throw new Error(`Account ${accountId} not found`);

  const config = buildImapConfig(account);

  // Phase 1: List and sync folders
  onProgress?.({ phase: "folders", current: 0, total: 1 });
  let allFolders;
  try {
    allFolders = await imapListFolders(config);
  } catch (err) {
    console.error(`[imapSync] Failed to list folders:`, err);
    throw err;
  }

  const syncableFolders = getSyncableFolders(allFolders);
  await syncFoldersToLabels(accountId, syncableFolders);
  onProgress?.({ phase: "folders", current: 1, total: 1 });

  // ---------------------------------------------------------------------------
  // Phase 2: Fetch + store per folder
  // Each imap_fetch_and_store call: IMAP fetch + rusqlite write, returns ~200 B/msg.
  // Zero SQL plugin (WebKit IPC) calls during this phase.
  // ---------------------------------------------------------------------------

  const allHeaders: ImapSyncHeader[] = [];
  // RFC Message-ID → accumulated labels from all folders (for cross-folder merging)
  const labelsByRfcId = new Map<string, Set<string>>();
  // Folder state updates to persist only after imapStoreThreads succeeds
  const pendingFolderStates: FolderSyncState[] = [];

  let totalEstimate = syncableFolders.reduce((s, f) => s + f.exists, 0);
  let fetchedTotal = 0;
  let storedCount = 0;
  let consecutiveFailures = 0;
  const folderErrors: string[] = [];

  for (let folderIdx = 0; folderIdx < syncableFolders.length; folderIdx++) {
    const folder = syncableFolders[folderIdx]!;
    if (folder.exists === 0) continue;

    if (consecutiveFailures >= CIRCUIT_BREAKER_MAX_FAILURES) {
      console.warn(`[imapSync] Circuit breaker: skipping remaining ${syncableFolders.length - folderIdx} folders`);
      break;
    }
    if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      await delay(CIRCUIT_BREAKER_DELAY_MS);
    }
    if (folderIdx > 0) await delay(INTER_FOLDER_DELAY_MS);

    const folderMapping = mapFolderToLabel(folder);

    try {
      let uidsToFetch: number[];
      let uidvalidity: number;

      if (daysBack > 0) {
        const sinceDate = computeSinceDate(daysBack);
        const searchResult = await imapSearchFolder(config, folder.raw_path, sinceDate);
        uidsToFetch = searchResult.uids;
        uidvalidity = searchResult.folder_status.uidvalidity;
      } else {
        const folderStatus = await imapGetFolderStatus(config, folder.raw_path);
        uidsToFetch = await imapSearchAllUids(config, folder.raw_path);
        uidvalidity = folderStatus.uidvalidity;
      }

      consecutiveFailures = 0;
      if (uidsToFetch.length === 0) continue;

      const cutoffDate = daysBack > 0 ? Math.floor(Date.now() / 1000) - daysBack * 86400 : 0;

      const { headers: folderHeaders, lastUid: folderLastUid } = await fetchAllInBatches(
        config,
        accountId,
        folder.raw_path,
        folderMapping.labelId,
        uidsToFetch,
        cutoffDate,
        (fetched) => {
          onProgress?.({
            phase: "messages",
            current: fetchedTotal + fetched,
            total: totalEstimate,
            folder: folder.path,
          });
        },
      );

      // Accumulate cross-folder label map from ALL headers (including skipped duplicates)
      for (const h of folderHeaders) {
        if (!h.message_id) continue;
        let labels = labelsByRfcId.get(h.message_id);
        if (!labels) { labels = new Set(); labelsByRfcId.set(h.message_id, labels); }
        labels.add(h.label_id);
        if (!h.is_read) labels.add("UNREAD");
        if (h.is_starred) labels.add("STARRED");
        if (h.is_draft) labels.add("DRAFT");
      }

      const folderStored = folderHeaders.filter((h) => h.stored).length;
      allHeaders.push(...folderHeaders);
      storedCount += folderStored;
      fetchedTotal += uidsToFetch.length;

      console.log(`[imapSync] Folder ${folder.path}: ${uidsToFetch.length} UIDs, ${folderStored} stored`);

      pendingFolderStates.push({
        account_id: accountId,
        folder_path: folder.raw_path,
        uidvalidity,
        last_uid: folderLastUid,
        modseq: null,
        last_sync_at: Math.floor(Date.now() / 1000),
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err ?? "Unknown error");
      console.error(`[imapSync] Failed to sync folder ${folder.path}:`, err);
      folderErrors.push(`${folder.path}: ${errMsg}`);
      if (isConnectionError(err)) consecutiveFailures++;
    }
  }

  if (storedCount === 0 && folderErrors.length > 0) {
    throw new Error(`All folders failed to sync: ${folderErrors[0]}`);
  }

  // ---------------------------------------------------------------------------
  // Phase 3: JWZ threading (pure in-memory — no DB reads)
  // ---------------------------------------------------------------------------
  onProgress?.({ phase: "threading", current: 0, total: allHeaders.length });

  const storedHeaders = allHeaders.filter((h) => h.stored);
  const allThreadable = storedHeaders.map(headerToThreadable);
  const rawThreadGroups = buildThreads(allThreadable);
  const headerById = new Map(allHeaders.map((h) => [h.local_id, h]));
  // RFC Message-ID based merge first (handles replies/forwards with proper headers),
  // then subject-based merge as fallback (handles replies that lack In-Reply-To).
  const rfcMergedGroups = await mergeGroupsByRfcId(accountId, rawThreadGroups, headerById);
  const threadGroups = await mergeGroupsBySubject(accountId, rfcMergedGroups, allThreadable);

  console.log(`[imapSync] Threading: ${storedHeaders.length} messages → ${threadGroups.length} threads`);

  // ---------------------------------------------------------------------------
  // Phase 4: Store threads — one rusqlite transaction via imap_store_threads
  // ---------------------------------------------------------------------------
  onProgress?.({ phase: "storing_threads", current: 0, total: threadGroups.length });

  // One SQL plugin call to get ALL pending op resource IDs (replaces N per-thread calls)
  const pendingOpIds = await getPendingOpResourceIds(accountId);
  const skipThreadIds = new Set(threadGroups.map((g) => g.threadId).filter((id) => pendingOpIds.has(id)));

  const allThreadIds = threadGroups.map((g) => g.threadId);
  const threadsWithExternalSenders = await getThreadsWithExternalSenders(accountId, account.email, allThreadIds);

  const { updates, urgencyQueue } = buildThreadUpdates(
    threadGroups, headerById, labelsByRfcId, skipThreadIds, account.email, threadsWithExternalSenders,
  );

  const allLocalIds = storedHeaders.map((h) => h.local_id);
  await imapStoreThreads(accountId, updates, allLocalIds);
  // Persist folder sync states only after thread storage succeeds to prevent stuck messages
  await Promise.all(pendingFolderStates.map(upsertFolderSyncState));

  // Apply any deferred cross-account user-label carry-overs now that the moved
  // messages have been imported and assigned thread_ids.
  await applyPendingLabelAssignments(accountId).catch((err) =>
    console.error(`[imapSync] applyPendingLabelAssignments error:`, err),
  );

  // Apply folder→label mappings: any thread whose messages live in a mapped folder
  // receives the corresponding user label automatically.
  const { applyFolderLabelMappings } = await import("@/services/db/folderLabelMappings");
  await applyFolderLabelMappings(accountId).catch((err) =>
    console.error(`[imapSync] applyFolderLabelMappings error:`, err),
  );

  onProgress?.({ phase: "storing_threads", current: threadGroups.length, total: threadGroups.length });

  // Fire urgency scoring outside of any DB lock
  for (const params of urgencyQueue) {
    processThreadUrgency({ ...params, accountId }).catch(() => {});
  }

  if (storedCount > 0) {
    await updateAccountSyncState(accountId, `imap-synced-${Date.now()}`);
  } else {
    console.warn(`[imapSync] Stored 0 messages — NOT marking sync complete so it will be retried`);
  }

  // PEC accounts: keep certified-mail receipts out of the inbox and always read.
  await reconcilePecReceipts(accountId).catch((err) =>
    console.error(`[imapSync] reconcilePecReceipts error:`, err),
  );

  onProgress?.({ phase: "done", current: storedCount, total: storedCount });
  return { messages: [] };
}

// ---------------------------------------------------------------------------
// Delta sync
// ---------------------------------------------------------------------------

export async function imapDeltaSync(accountId: string, daysBack = 365): Promise<SyncResult> {
  const account = await getAccount(accountId);
  if (!account) throw new Error(`Account ${accountId} not found`);

  const config = buildImapConfig(account);
  const syncStates = await getAllFolderSyncStates(accountId);

  const cycleCount = (_deltaSyncCycleCount.get(accountId) ?? 0) + 1;
  _deltaSyncCycleCount.set(accountId, cycleCount);
  const isMaintenanceCycle = cycleCount % MAINTENANCE_EVERY_N_CYCLES === 1;

  let allFolders;
  if (isMaintenanceCycle || syncStates.length === 0) {
    allFolders = await imapListFolders(config);
    await syncFoldersToLabels(accountId, getSyncableFolders(allFolders));
  } else {
    // Reconstruct the folder list from cached sync-state instead of listing from
    // the server. We MUST preserve each folder's special-use attribute, otherwise
    // system folders whose hierarchy delimiter is not "/" (e.g. Courier/Dovecot
    // "INBOX." namespace: "INBOX.Trash", "INBOX.Sent") fail special-folder
    // detection in mapFolderToLabel and get mis-mapped to a generic
    // `folder-<path>` user label. That in turn makes computeThreadLabels add
    // INBOX/UNREAD to trashed messages, leaking the whole Trash folder into the
    // Inbox as unread. special_use + name come from the labels table, which is
    // refreshed on maintenance cycles from the authoritative server folder list.
    const cachedLabels = await getLabelsForAccount(accountId);
    const metaByPath = new Map(
      cachedLabels
        .filter((l) => l.imap_folder_path)
        .map((l) => [l.imap_folder_path as string, l]),
    );
    allFolders = syncStates.map((s) => {
      const meta = metaByPath.get(s.folder_path);
      return {
        path: s.folder_path,
        raw_path: s.folder_path,
        name: meta?.name ?? s.folder_path.split("/").pop() ?? s.folder_path,
        delimiter: "/",
        special_use: meta?.imap_special_use ?? null,
        exists: 0,
        unseen: 0,
        parent_path: null,
        has_children: false,
      };
    });
  }
  const syncableFolders = getSyncableFolders(allFolders);

  if (isMaintenanceCycle) {
    const dupeCount = await purgeImapDuplicates(accountId).catch(() => 0);
    if (dupeCount > 0) console.log(`[imapSync] Purged ${dupeCount} duplicates for ${accountId}`);
    await reconcileOrphanMessages(accountId).catch((err) =>
      console.error(`[imapSync] reconcileOrphanMessages error:`, err),
    );
    const orphanThreadCount = await purgeOrphanPlaceholderThreads(accountId).catch(() => 0);
    if (orphanThreadCount > 0) console.log(`[imapSync] Purged ${orphanThreadCount} orphan placeholder thread(s) for ${accountId}`);
    const fragmentCount = await reconcileFragmentedThreads(accountId).catch((err) =>
      (console.error(`[imapSync] reconcileFragmentedThreads error:`, err), 0),
    );
    if (fragmentCount > 0) console.log(`[imapSync] Repaired ${fragmentCount} fragmented thread(s) for ${accountId}`);
    await pruneDeletedImapUids().catch(() => {});
  }

  const syncStateMap = new Map(syncStates.map((s) => [s.folder_path, s]));
  const newFolders = syncableFolders.filter((f) => !syncStateMap.has(f.raw_path));
  const existingFolders = syncableFolders.filter((f) => syncStateMap.has(f.raw_path));

  // All headers from new messages across all folders (stored + skipped duplicates)
  const allHeaders: ImapSyncHeader[] = [];
  const labelsByRfcId = new Map<string, Set<string>>();
  // Folder state updates to persist only after imapStoreThreads succeeds
  const pendingFolderStates: FolderSyncState[] = [];

  let consecutiveFailures = 0;
  let flagChangedCount = 0;
  let unfetchableCount = 0;
  const unfetchableMaxRetries = await getUnfetchableMaxRetries();
  const deltaFolderErrors: string[] = [];

  // ---- New folders ----
  for (const folder of newFolders) {
    if (consecutiveFailures >= CIRCUIT_BREAKER_MAX_FAILURES) break;
    if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) await delay(CIRCUIT_BREAKER_DELAY_MS);

    const folderMapping = mapFolderToLabel(folder);
    try {
      let uidsToFetch: number[];
      let uidvalidity: number;

      if (daysBack > 0) {
        const sinceDate = computeSinceDate(daysBack);
        const searchResult = await imapSearchFolder(config, folder.raw_path, sinceDate);
        uidsToFetch = searchResult.uids;
        uidvalidity = searchResult.folder_status.uidvalidity;
      } else {
        const folderStatus = await imapGetFolderStatus(config, folder.raw_path);
        uidsToFetch = await imapSearchAllUids(config, folder.raw_path);
        uidvalidity = folderStatus.uidvalidity;
      }
      consecutiveFailures = 0;
      if (uidsToFetch.length === 0) continue;

      const cutoffDate = daysBack > 0 ? Math.floor(Date.now() / 1000) - daysBack * 86400 : 0;
      const { headers, lastUid } = await fetchAllInBatches(
        config, accountId, folder.raw_path, folderMapping.labelId, uidsToFetch, cutoffDate,
      );

      _accumLabels(headers, labelsByRfcId);
      allHeaders.push(...headers);

      pendingFolderStates.push({
        account_id: accountId,
        folder_path: folder.raw_path,
        uidvalidity,
        last_uid: lastUid,
        modseq: null,
        last_sync_at: Math.floor(Date.now() / 1000),
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err ?? "Unknown error");
      console.error(`Delta sync failed for new folder ${folder.path}:`, err);
      deltaFolderErrors.push(`${folder.path}: ${errMsg}`);
      if (isConnectionError(err)) consecutiveFailures++;
    }
  }

  // ---- Existing folders — batch delta check ----
  if (existingFolders.length > 0) {
    // Folders whose cursor was reset to 0 take the full-reconcile path below and
    // ignore delta_check entirely (DavMail mishandles the range query), so don't
    // waste a round-trip enumerating them here.
    const deltaRequests: DeltaCheckRequest[] = existingFolders
      .filter((folder) => syncStateMap.get(folder.raw_path)!.last_uid > 0)
      .map((folder) => {
        const savedState = syncStateMap.get(folder.raw_path)!;
        return {
          folder: folder.raw_path,
          last_uid: savedState.last_uid,
          uidvalidity: savedState.uidvalidity ?? 0,
          last_sync_at: savedState.last_sync_at ?? null,
        };
      });

    let deltaResultMap: Map<string, DeltaCheckResult> = new Map();
    try {
      if (deltaRequests.length > 0) {
        const deltaResults = await imapDeltaCheck(config, deltaRequests);
        deltaResultMap = new Map(deltaResults.map((r) => [r.folder, r]));
      }
    } catch (err) {
      console.warn(`[imapSync] Batch delta check failed, falling back to per-folder:`, err);
      deltaResultMap = new Map();
      for (const folder of existingFolders) {
        const savedState = syncStateMap.get(folder.raw_path)!;
        try {
          const currentStatus = await imapGetFolderStatus(config, folder.raw_path);
          // Only treat UIDVALIDITY as changed when the server reports a *valid*
          // new value. DavMail/Exchange and flaky connections occasionally return
          // 0/null/NaN after an error or reconnect; trusting that here would flag a
          // bogus change and trigger a full-folder purge (this is what wiped
          // thousands of messages). A non-positive value is never a real
          // UIDVALIDITY, so ignore it and keep the stored mail.
          const uidvalidityChanged =
            savedState.uidvalidity !== null &&
            typeof currentStatus.uidvalidity === "number" &&
            Number.isFinite(currentStatus.uidvalidity) &&
            currentStatus.uidvalidity > 0 &&
            currentStatus.uidvalidity !== savedState.uidvalidity;
          if (uidvalidityChanged) {
            deltaResultMap.set(folder.raw_path, {
              folder: folder.raw_path,
              uidvalidity: currentStatus.uidvalidity,
              new_uids: [],
              uidvalidity_changed: true,
            });
          } else {
            let newUids = await imapFetchNewUids(config, folder.raw_path, savedState.last_uid);
            if (newUids.length === 0 && savedState.last_sync_at) {
              const sinceDate = formatImapDate(new Date((savedState.last_sync_at - 86_400) * 1000));
              const searchResult = await imapSearchFolder(config, folder.raw_path, sinceDate);
              newUids = searchResult.uids.filter((uid) => uid > savedState.last_uid);
            }
            deltaResultMap.set(folder.raw_path, {
              folder: folder.raw_path,
              uidvalidity: currentStatus.uidvalidity,
              new_uids: newUids,
              uidvalidity_changed: false,
            });
          }
        } catch (folderErr) {
          console.error(`[imapSync] Per-folder check failed for ${folder.path}:`, folderErr);
        }
      }
    }

    for (const folder of existingFolders) {
      const folderMapping = mapFolderToLabel(folder);
      const savedState = syncStateMap.get(folder.raw_path)!;

      // ---- Full reconcile path (cursor reset to 0) ----
      // A folder whose cursor is 0 needs a complete (re)sync. DavMail/Exchange
      // mishandle open-ended `n:*` UID range searches, so we never trust
      // delta_check here — reconcileFolderAdditions enumerates authoritatively
      // (`UID SEARCH NOT DELETED`) and fetches exactly what's missing locally.
      // Inherently resumable and never silently incomplete.
      if (savedState.last_uid === 0) {
        try {
          const res = await reconcileFolderAdditions(config, accountId, folder.raw_path, folderMapping.labelId, unfetchableMaxRetries);
          if (!res) {
            // Empty/failed enumeration — never advance the cursor (retry next
            // cycle) and never purge; treated as a transient hiccup, not a folder
            // error, so it can't trip the all-folders-failed guard.
            console.warn(`[imapSync] Full reconcile: enumeration returned 0 UIDs for ${folder.path} — will retry next cycle`);
            continue;
          }
          _accumLabels(res.headers, labelsByRfcId);
          allHeaders.push(...res.headers);
          unfetchableCount += res.unfetchable;

          pendingFolderStates.push({
            account_id: accountId,
            folder_path: folder.raw_path,
            uidvalidity: savedState.uidvalidity ?? 1,
            last_uid: res.serverMaxUid,
            modseq: null,
            last_sync_at: Math.floor(Date.now() / 1000),
          });

          const changed = await syncReadFlagsForFolder(config, accountId, folder.raw_path).catch(() => 0);
          flagChangedCount += changed;
        } catch (err) {
          // Transient error mid-reconcile — leave the cursor at 0 so the next
          // cycle resumes (fetching only what is still missing).
          const errMsg = err instanceof Error ? err.message : String(err ?? "Unknown error");
          console.error(`[imapSync] Full reconcile failed for ${folder.path}:`, err);
          deltaFolderErrors.push(`${folder.path}: ${errMsg}`);
        }
        continue;
      }

      const deltaResult = deltaResultMap.get(folder.raw_path);
      if (!deltaResult) continue;

      try {
        if (deltaResult.uidvalidity_changed) {
          // A UIDVALIDITY change purges the whole folder before resyncing, so this
          // path is the single most destructive operation in sync. Before deleting
          // anything we (1) search the server and (2) confirm the result is sane.
          // We NEVER purge a non-empty local folder when the server search came
          // back empty or failed — that combination means a flaky/failed response,
          // not a genuinely emptied mailbox, and blindly deleting there is exactly
          // what caused mass data loss before.
          let uidvalidityUids: number[];
          let uidvalidityVal: number;
          try {
            if (daysBack > 0) {
              const sinceDate = computeSinceDate(daysBack);
              const searchResult = await imapSearchFolder(config, folder.raw_path, sinceDate);
              uidvalidityUids = searchResult.uids;
              uidvalidityVal = searchResult.folder_status.uidvalidity;
            } else {
              const folderStatus = await imapGetFolderStatus(config, folder.raw_path);
              uidvalidityUids = await imapSearchAllUids(config, folder.raw_path);
              uidvalidityVal = folderStatus.uidvalidity;
            }
          } catch (searchErr) {
            console.warn(
              `[imapSync] UIDVALIDITY resync search failed for ${folder.path} — skipping purge to avoid data loss:`,
              searchErr,
            );
            continue;
          }

          const { getStoredImapUidsForFolder } = await import("../db/messages");
          const storedCount = (await getStoredImapUidsForFolder(accountId, folder.raw_path)).length;
          if (storedCount > 0 && uidvalidityUids.length === 0) {
            console.warn(
              `[imapSync] UIDVALIDITY change for ${folder.path}: server search returned 0 UIDs but ${storedCount} message(s) are stored locally — skipping purge (treating as a failed/empty search, not a real reset).`,
            );
            continue;
          }

          console.warn(`UIDVALIDITY changed for ${folder.path} — purging and resyncing`);
          await deleteMessagesForFolder(accountId, folder.raw_path);
          await clearDeletedImapUidsForFolder(accountId, folder.raw_path).catch(() => {});

          if (uidvalidityUids.length > 0) {
            const cutoffDate = daysBack > 0 ? Math.floor(Date.now() / 1000) - daysBack * 86400 : 0;
            const { headers, lastUid } = await fetchAllInBatches(
              config, accountId, folder.raw_path, folderMapping.labelId, uidvalidityUids, cutoffDate,
            );
            _accumLabels(headers, labelsByRfcId);
            allHeaders.push(...headers);
            pendingFolderStates.push({
              account_id: accountId,
              folder_path: folder.raw_path,
              uidvalidity: uidvalidityVal,
              last_uid: lastUid,
              modseq: null,
              last_sync_at: Math.floor(Date.now() / 1000),
            });
          }
          continue;
        }

        const uidsToFetch = deltaResult.new_uids;

        if (uidsToFetch.length === 0) {
          await upsertFolderSyncState({
            account_id: accountId,
            folder_path: folder.raw_path,
            uidvalidity: deltaResult.uidvalidity,
            last_uid: savedState.last_uid,
            modseq: null,
            last_sync_at: Math.floor(Date.now() / 1000),
          });
          if (isMaintenanceCycle) {
            await reconcileDeletedMessages(config, accountId, folder.raw_path);
          }
          const changed = await syncReadFlagsForFolder(config, accountId, folder.raw_path).catch((err) => {
            console.error(`[imapSync] syncReadFlagsForFolder error:`, err);
            return 0;
          });
          flagChangedCount += changed;
          continue;
        }

        const cutoffDate = 0; // delta sync: no date cutoff — fetch all new UIDs
        const { headers, lastUid } = await fetchAllInBatches(
          config, accountId, folder.raw_path, folderMapping.labelId, uidsToFetch, cutoffDate,
        );
        _accumLabels(headers, labelsByRfcId);
        allHeaders.push(...headers);

        pendingFolderStates.push({
          account_id: accountId,
          folder_path: folder.raw_path,
          uidvalidity: deltaResult.uidvalidity,
          last_uid: Math.max(savedState.last_uid, lastUid),
          modseq: null,
          last_sync_at: Math.floor(Date.now() / 1000),
        });

        if (isMaintenanceCycle) {
          await reconcileDeletedMessages(config, accountId, folder.raw_path);
        }
        // Always sync read flags even when new messages arrived — ensures
        // messages read on another device clear their badge in this cycle.
        {
          const changed = await syncReadFlagsForFolder(config, accountId, folder.raw_path).catch((err) => {
            console.error(`[imapSync] syncReadFlagsForFolder error:`, err);
            return 0;
          });
          flagChangedCount += changed;
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err ?? "Unknown error");
        console.error(`Delta sync failed for folder ${folder.path}:`, err);
        deltaFolderErrors.push(`${folder.path}: ${errMsg}`);
      }
    }

    // ---- Periodic self-healing additions reconcile (maintenance cycles) ----
    // The delta path above handles new mail, flag changes, UIDVALIDITY and
    // deletions — but it leans on `n:*` range searches that DavMail/Exchange can
    // mishandle, so a message can silently fail to appear and never be retried
    // (the cursor advances past it). Once every MAINTENANCE_EVERY_N_CYCLES we
    // additionally diff the authoritative `UID SEARCH NOT DELETED` set against
    // the local DB and pull anything missing. This makes ongoing sync
    // self-correcting: drift is caught within minutes instead of forever.
    if (isMaintenanceCycle) {
      for (const folder of existingFolders) {
        const savedState = syncStateMap.get(folder.raw_path)!;
        if (savedState.last_uid === 0) continue; // already fully reconciled above
        const folderMapping = mapFolderToLabel(folder);
        try {
          const res = await reconcileFolderAdditions(config, accountId, folder.raw_path, folderMapping.labelId, unfetchableMaxRetries);
          if (!res || res.headers.length === 0) {
            unfetchableCount += res?.unfetchable ?? 0;
            continue;
          }
          _accumLabels(res.headers, labelsByRfcId);
          allHeaders.push(...res.headers);
          unfetchableCount += res.unfetchable;
          pendingFolderStates.push({
            account_id: accountId,
            folder_path: folder.raw_path,
            uidvalidity: savedState.uidvalidity ?? 1,
            last_uid: Math.max(savedState.last_uid, res.serverMaxUid),
            modseq: null,
            last_sync_at: Math.floor(Date.now() / 1000),
          });
        } catch (err) {
          console.error(`[imapSync] Maintenance additions reconcile failed for ${folder.path}:`, err);
        }
      }
    }
  }

  if (allHeaders.filter((h) => h.stored).length === 0 && deltaFolderErrors.length > 0) {
    throw new Error(`All folders failed to sync: ${deltaFolderErrors[0]}`);
  }

  // Surface the persistent skip-list size (messages the server keeps refusing to
  // serve) rather than just this cycle's failures, so the UI warning reflects the
  // real ongoing incompleteness — never silent.
  unfetchableCount = await getUnfetchableCountForAccount(accountId, unfetchableMaxRetries).catch(() => unfetchableCount);

  const storedHeaders = allHeaders.filter((h) => h.stored);
  if (storedHeaders.length === 0) {
    // No new messages, but still persist folder states (records last_uid / last_sync_at)
    await Promise.all(pendingFolderStates.map(upsertFolderSyncState));
    // A prior cycle may have imported a cross-account-moved message whose
    // deferred label is still pending — try to apply it now.
    await applyPendingLabelAssignments(accountId).catch((err) =>
      console.error(`[imapSync] applyPendingLabelAssignments error:`, err),
    );
    return { messages: [], storedCount: 0, flagChangedCount, unfetchableCount };
  }

  // JWZ threading + RFC ID merge + subject-based merge with existing threads
  const allThreadable = storedHeaders.map(headerToThreadable);
  const rawThreadGroups = buildThreads(allThreadable);
  // Thread updates — one SQL plugin call for pending ops, then one Rust call for writes
  const headerById = new Map(allHeaders.map((h) => [h.local_id, h]));
  // RFC Message-ID based merge first (handles sent replies arriving via delta sync),
  // then subject-based merge as fallback (for replies lacking threading headers).
  const rfcMergedGroups = await mergeGroupsByRfcId(accountId, rawThreadGroups, headerById);
  const threadGroups = await mergeGroupsBySubject(accountId, rfcMergedGroups, allThreadable);
  const pendingOpIds = await getPendingOpResourceIds(accountId);
  const skipThreadIds = new Set(threadGroups.map((g) => g.threadId).filter((id) => pendingOpIds.has(id)));

  const allThreadIds = threadGroups.map((g) => g.threadId);
  const threadsWithExternalSenders = await getThreadsWithExternalSenders(accountId, account.email, allThreadIds);

  const { updates, urgencyQueue } = buildThreadUpdates(
    threadGroups, headerById, labelsByRfcId, skipThreadIds, account.email, threadsWithExternalSenders,
  );

  const allLocalIds = storedHeaders.map((h) => h.local_id);
  await imapStoreThreads(accountId, updates, allLocalIds);
  // Persist folder sync states only after thread storage succeeds to prevent stuck messages
  await Promise.all(pendingFolderStates.map(upsertFolderSyncState));

  // Apply any deferred cross-account user-label carry-overs now that the moved
  // messages have been imported and assigned thread_ids.
  await applyPendingLabelAssignments(accountId).catch((err) =>
    console.error(`[imapSync] applyPendingLabelAssignments error:`, err),
  );

  // Apply folder→label mappings for new messages in mapped folders
  const { applyFolderLabelMappings } = await import("@/services/db/folderLabelMappings");
  await applyFolderLabelMappings(accountId).catch((err) =>
    console.error(`[imapSync] applyFolderLabelMappings error:`, err),
  );

  // Run fragmented-thread reconciliation on every cycle that stored new messages.
  // New messages can create new fragments (subject mismatches, missing parents arriving
  // later, etc.), and any normalization fixes only kick in once reconcile runs.
  // Maintenance cycles already invoked it earlier; this catches the non-maintenance ones.
  if (!isMaintenanceCycle) {
    const fragmentCount = await reconcileFragmentedThreads(accountId).catch((err) =>
      (console.error(`[imapSync] reconcileFragmentedThreads (post-store) error:`, err), 0),
    );
    if (fragmentCount > 0) console.log(`[imapSync] Repaired ${fragmentCount} fragmented thread(s) for ${accountId} (post-store)`);

    // De-dupe right after storing new messages. A just-sent reply is saved locally with
    // the APPENDUID; when the server returns an inconsistent UID, this delta import creates
    // a second row for the same physical message (same Message-ID + folder, different UID).
    // Without this, the duplicate lingered until the next maintenance cycle (~10 min) or a
    // manual resync. Maintenance cycles already purged at the top; this covers the rest.
    const dupeCount = await purgeImapDuplicates(accountId).catch(() => 0);
    if (dupeCount > 0) console.log(`[imapSync] Purged ${dupeCount} duplicate(s) for ${accountId} (post-store)`);
  }

  for (const params of urgencyQueue) {
    processThreadUrgency({ ...params, accountId }).catch(() => {});
  }

  // Desktop notifications for new unread INBOX messages (same smart-filter logic as Gmail)
  const smartNotifications = (await getSetting("smart_notifications")) !== "false";
  const notifyCategories = new Set(
    ((await getSetting("notify_categories")) ?? "Primary").split(",").map((s) => s.trim()).filter(Boolean),
  );
  const vipSenders = smartNotifications ? await getVipSenders(accountId) : new Set<string>();
  // Muted threads must not notify — mirrors the Gmail sync path (sync.ts).
  const { getMutedThreadIds } = await import("../db/threads");
  const mutedThreadIds = await getMutedThreadIds(accountId).catch(() => new Set<string>());

  // Threads skipped because of a pending local op never reach the notify loop —
  // leave a diagnostic trace so a "missing notification" report is explainable.
  if (skipThreadIds.size > 0) {
    logNotificationSuppressed(
      "threads with pending local ops excluded from sync updates",
      `count=${skipThreadIds.size}`,
    );
  }

  // urgencyQueue[i] corresponds to updates[i] — zip them for notification purposes
  for (let i = 0; i < updates.length; i++) {
    const update = updates[i]!;
    const uq = urgencyQueue[i]!;
    if (!update.label_ids.includes("INBOX")) continue;
    if (update.is_read) {
      // A new-but-already-read INBOX arrival is the interesting anomaly here
      // (server-side filter, another client, or a \Seen delivery).
      logNotificationSuppressed("delivered already read", `thread=${update.thread_id} subject=${update.subject ?? ""}`);
      continue;
    }
    if (mutedThreadIds.has(update.thread_id)) {
      logNotificationSuppressed("muted thread", `thread=${update.thread_id}`);
      continue;
    }
    const fromAddr = uq.fromAddress ?? undefined;
    const threadCategory = await getThreadCategory(accountId, update.thread_id);
    if (shouldNotifyForMessage(smartNotifications, notifyCategories, vipSenders, threadCategory, fromAddr)) {
      queueNewEmailNotification(
        uq.fromName ?? uq.fromAddress ?? "Unknown",
        update.subject ?? "",
        update.thread_id,
        accountId,
        fromAddr,
        uq.bodyText ?? undefined,
      );
    } else {
      logNotificationSuppressed(
        "smart-notification category filter",
        `category=${threadCategory ?? "Primary"} from=${fromAddr ?? "?"} subject=${update.subject ?? ""}`,
      );
    }
  }

  // Second pass: cross-folder duplicates that arrived in INBOX. The store layer
  // skips them (same RFC Message-ID already stored under another folder), so they
  // never become thread updates — but for the user this IS a new inbox arrival
  // (e.g. a server-side filter copy processed before INBOX). Without this pass
  // such messages are never notified. Recency-capped so late reconciles of old
  // mail can't fire stale notifications.
  const DUP_NOTIFY_MAX_AGE_MS = 48 * 60 * 60 * 1000;
  const dupCutoff = Date.now() - DUP_NOTIFY_MAX_AGE_MS;
  for (const h of allHeaders) {
    if (h.stored || h.label_id !== "INBOX" || h.is_read) continue;
    if (!(h.date > dupCutoff)) {
      logNotificationSuppressed("cross-folder INBOX duplicate older than 48h", `subject=${h.subject ?? ""}`);
      continue;
    }
    // Resolve the category of the thread holding the already-stored copy.
    let dupCategory: string | null = null;
    let dupThreadId: string | undefined;
    if (h.message_id) {
      try {
        const { getDb } = await import("../db/connection");
        const db = await getDb();
        const rows = await db.select<{ thread_id: string }[]>(
          `SELECT thread_id FROM messages WHERE account_id = $1 AND message_id_header = $2 LIMIT 1`,
          [accountId, h.message_id],
        );
        dupThreadId = rows[0]?.thread_id;
        if (dupThreadId) {
          if (mutedThreadIds.has(dupThreadId)) {
            logNotificationSuppressed("muted thread (cross-folder duplicate)", `thread=${dupThreadId}`);
            continue;
          }
          dupCategory = await getThreadCategory(accountId, dupThreadId);
        }
      } catch {
        // Lookup failure → fall through with defaults (category Primary)
      }
    }
    if (shouldNotifyForMessage(smartNotifications, notifyCategories, vipSenders, dupCategory, h.from_address ?? undefined)) {
      queueNewEmailNotification(
        h.from_name ?? h.from_address ?? "Unknown",
        h.subject ?? "",
        dupThreadId,
        accountId,
        h.from_address ?? undefined,
        h.snippet || undefined,
      );
    } else {
      logNotificationSuppressed(
        "smart-notification category filter (cross-folder duplicate)",
        `category=${dupCategory ?? "Primary"} subject=${h.subject ?? ""}`,
      );
    }
  }

  await updateAccountSyncState(accountId, `imap-synced-${Date.now()}`);

  // PEC accounts: keep certified-mail receipts out of the inbox and always read.
  await reconcilePecReceipts(accountId).catch((err) =>
    console.error(`[imapSync] reconcilePecReceipts error:`, err),
  );

  return { messages: storedHeaders as unknown as ParsedMessage[], storedCount: storedHeaders.length, flagChangedCount, unfetchableCount };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Recovery: find messages stored in the DB without corresponding thread_labels entries
 * (e.g. due to a previous imapStoreThreads failure) and re-thread them.
 * Called during maintenance cycles.
 */
async function reconcileOrphanMessages(accountId: string): Promise<void> {
  const { getDb } = await import("../db/connection");
  const db = await getDb();

  type OrphanRow = {
    thread_id: string;
    msg_id: string;
    subject: string | null;
    snippet: string | null;
    date: number;
    is_read: number;
    is_starred: number;
    is_trashed: number;
    imap_folder: string | null;
    label_id: string | null;
  };

  const rows = await db.select<OrphanRow[]>(
    `SELECT
       m.thread_id,
       m.id          AS msg_id,
       m.subject,
       m.snippet,
       m.date,
       m.is_read,
       m.is_starred,
       m.is_trashed,
       m.imap_folder,
       l.id          AS label_id
     FROM messages m
     LEFT JOIN labels l
       ON l.account_id = m.account_id AND l.imap_folder_path = m.imap_folder
     WHERE m.account_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM thread_labels tl
         WHERE tl.account_id = m.account_id AND tl.thread_id = m.thread_id
       )
     ORDER BY m.thread_id, m.date`,
    [accountId],
  );

  if (rows.length === 0) return;

  // Group by thread_id
  const byThread = new Map<string, OrphanRow[]>();
  for (const row of rows) {
    let msgs = byThread.get(row.thread_id);
    if (!msgs) { msgs = []; byThread.set(row.thread_id, msgs); }
    msgs.push(row);
  }

  // Check which orphan threads have attachments
  const orphanThreadIds = [...byThread.keys()];
  const phT = orphanThreadIds.map((_, i) => `$${i + 2}`).join(", ");
  const attachRows = await db.select<{ thread_id: string }[]>(
    `SELECT DISTINCT m.thread_id
     FROM attachments a
     INNER JOIN messages m ON m.account_id = a.account_id AND m.id = a.message_id
     WHERE a.account_id = $1 AND m.thread_id IN (${phT})`,
    [accountId, ...orphanThreadIds],
  );
  const threadsWithAttachments = new Set(attachRows.map((r) => r.thread_id));

  const updates: ImapThreadUpdate[] = [];
  const allMsgIds: string[] = [];

  for (const [threadId, msgs] of byThread) {
    const first = msgs[0]!;
    const last = msgs[msgs.length - 1]!;

    // Trashed messages don't count toward the thread read state (an unread
    // message in Trash must not render the thread as unread in the Inbox).
    const isRead = msgs
      .filter((m) => m.is_trashed === 0)
      .every((m) => m.is_read === 1);
    const isStarred = msgs.some((m) => m.is_starred === 1);
    const hasAttachments = threadsWithAttachments.has(threadId);

    // Derive label_ids from folder mappings + pseudo-labels
    const labelSet = new Set<string>();
    for (const m of msgs) {
      if (m.label_id) labelSet.add(m.label_id);
      if (m.is_read === 0 && m.is_trashed === 0) labelSet.add("UNREAD");
      if (m.is_starred === 1) labelSet.add("STARRED");
    }

    updates.push({
      thread_id: threadId,
      message_ids: msgs.map((m) => m.msg_id),
      subject: first.subject,
      snippet: last.snippet,
      last_message_at: last.date,
      is_read: isRead,
      is_starred: isStarred,
      has_attachments: hasAttachments,
      label_ids: [...labelSet],
    });
    allMsgIds.push(...msgs.map((m) => m.msg_id));
  }

  if (updates.length === 0) return;

  console.log(`[imapSync] reconcileOrphanMessages: re-threading ${updates.length} orphan thread(s) for ${accountId}`);
  try {
    await imapStoreThreads(accountId, updates, allMsgIds);
  } catch (err) {
    console.error(`[imapSync] reconcileOrphanMessages failed:`, err);
  }
}

/**
 * Detect and repair fragmented threads: conversations split across multiple DB thread
 * records that JWZ would unify if run on the complete message set.
 *
 * Fragmentation happens when messages in the same conversation arrive in different
 * delta-sync cycles (out-of-order delivery, cross-folder copies, etc.) and the
 * per-cycle JWZ pass couldn't link them at the time they were stored.
 *
 * This function loads all message threading headers from the DB, re-runs the full
 * JWZ algorithm on the complete set, and merges any groups whose messages are
 * currently spread across more than one thread_id.
 */
async function reconcileFragmentedThreads(accountId: string): Promise<number> {
  const { getDb } = await import("../db/connection");
  const db = await getDb();
  const account = await getAccount(accountId);
  if (!account) return 0;

  type MsgRow = {
    id: string;
    message_id_header: string | null;
    in_reply_to_header: string | null;
    references_header: string | null;
    subject: string | null;
    date: number;
    thread_id: string;
    snippet: string | null;
    is_read: number;
    is_starred: number;
    is_trashed: number;
  };

  const rows = await db.select<MsgRow[]>(
    `SELECT id, message_id_header, in_reply_to_header, references_header,
            subject, date, thread_id, snippet, is_read, is_starred, is_trashed
     FROM messages
     WHERE account_id = $1
     ORDER BY date ASC`,
    [accountId],
  );

  if (rows.length === 0) return 0;

  const threadable: ThreadableMessage[] = rows.map((r) => ({
    id: r.id,
    messageId: r.message_id_header ?? `synthetic-${r.id}@melo.local`,
    inReplyTo: r.in_reply_to_header,
    references: r.references_header,
    subject: r.subject,
    date: r.date,
  }));

  const newGroups = buildThreads(threadable);

  // Detect groups where messages are currently spread across more than one thread_id
  const currentThreadById = new Map(rows.map((r) => [r.id, r.thread_id]));
  const changedGroups: ThreadGroup[] = [];

  for (const group of newGroups) {
    const currentIds = new Set(
      group.messageIds.map((id) => currentThreadById.get(id)).filter(Boolean),
    );
    if (currentIds.size <= 1) continue; // already unified
    changedGroups.push(group);
  }

  if (changedGroups.length === 0) return 0;

  // Load thread_labels for all fragment threads so we can merge their label sets
  const involvedThreadIds = new Set<string>();
  for (const group of changedGroups) {
    for (const msgId of group.messageIds) {
      const tid = currentThreadById.get(msgId);
      if (tid) involvedThreadIds.add(tid);
    }
  }

  const threadLabelMap = new Map<string, Set<string>>();
  {
    const ids = [...involvedThreadIds];
    const CHUNK = 500;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const ph = chunk.map((_, j) => `$${j + 2}`).join(",");
      const labelRows = await db.select<{ thread_id: string; label_id: string }[]>(
        `SELECT thread_id, label_id FROM thread_labels WHERE account_id = $1 AND thread_id IN (${ph})`,
        [accountId, ...chunk],
      );
      for (const row of labelRows) {
        let set = threadLabelMap.get(row.thread_id);
        if (!set) { set = new Set(); threadLabelMap.set(row.thread_id, set); }
        set.add(row.label_id);
      }
    }
  }

  // has_attachments lives on threads, not messages. Derive per-thread from attachments.
  const changedThreadIds = new Set<string>();
  for (const group of changedGroups) {
    for (const msgId of group.messageIds) {
      const tid = currentThreadById.get(msgId);
      if (tid) changedThreadIds.add(tid);
    }
  }
  const threadsWithAttachments = new Set<string>();
  if (changedThreadIds.size > 0) {
    const ids = [...changedThreadIds];
    const CHUNK = 500;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const ph = chunk.map((_, j) => `$${j + 2}`).join(",");
      const attRows = await db.select<{ thread_id: string }[]>(
        `SELECT DISTINCT m.thread_id
         FROM attachments a
         INNER JOIN messages m ON m.account_id = a.account_id AND m.id = a.message_id
         WHERE a.account_id = $1 AND m.thread_id IN (${ph})`,
        [accountId, ...chunk],
      );
      for (const row of attRows) threadsWithAttachments.add(row.thread_id);
    }
  }

  const rowById = new Map(rows.map((r) => [r.id, r]));
  const updates: ImapThreadUpdate[] = [];
  const allOldThreadIds = new Set<string>();

  for (const group of changedGroups) {
    const msgs = group.messageIds
      .map((id) => rowById.get(id))
      .filter((r): r is MsgRow => r !== undefined);
    msgs.sort((a, b) => a.date - b.date);
    if (msgs.length === 0) continue;

    const first = msgs[0]!;
    const last = msgs[msgs.length - 1]!;

    // Union labels from all fragment threads, then reconcile pseudo-labels
    const mergedLabels = new Set<string>();
    for (const msgId of group.messageIds) {
      const oldTid = currentThreadById.get(msgId);
      if (oldTid) {
        allOldThreadIds.add(oldTid);
        const labels = threadLabelMap.get(oldTid);
        if (labels) for (const l of labels) mergedLabels.add(l);
      }
    }

    // Trashed messages don't count: an unread message in Trash must not mark
    // the merged thread unread in the Inbox.
    const allRead = msgs
      .filter((m) => m.is_trashed === 0)
      .every((m) => m.is_read === 1);
    if (allRead) mergedLabels.delete("UNREAD");
    else mergedLabels.add("UNREAD");

    const anyStarred = msgs.some((m) => m.is_starred === 1);
    if (anyStarred) mergedLabels.add("STARRED");
    else mergedLabels.delete("STARRED");

    updates.push({
      thread_id: group.threadId,
      message_ids: group.messageIds,
      subject: first.subject,
      snippet: last.snippet,
      last_message_at: last.date,
      is_read: allRead,
      is_starred: anyStarred,
      has_attachments: group.messageIds.some((id) => {
        const tid = currentThreadById.get(id);
        return tid ? threadsWithAttachments.has(tid) : false;
      }),
      label_ids: [...mergedLabels],
    });
  }

  if (updates.length === 0) return 0;

  console.log(`[imapSync] reconcileFragmentedThreads: merging ${changedGroups.length} fragmented thread(s) for ${accountId}`);

  // Pass old thread IDs as all_local_ids — imap_store_threads will delete any that
  // become empty after messages are remapped to the new unified thread_id.
  await imapStoreThreads(accountId, updates, [...allOldThreadIds]);

  return changedGroups.length;
}

/**
 * One-time startup repair: re-fetches IMAP Sent messages that have an imap_uid but
 * no rows in the attachments table. These were stored by saveSentMessageLocally()
 * before the fix that populates attachment metadata immediately on send.
 *
 * Targets messages whose imap_folder looks like a Sent folder (case-insensitive
 * "sent" match) — covers "Sent", "Sent Items", "Sent Messages", "Posta Inviata", etc.
 * Does NOT rely on thread_labels because sent replies are threaded under INBOX.
 *
 * Completion is tracked by the DB setting 'sent_attachment_repair_v2'.
 */
export async function repairSentAttachments(imapAccountIds: string[]): Promise<void> {
  const { getSetting, setSetting } = await import('../db/settings');
  const already = await getSetting('sent_attachment_repair_v2');
  if (already === '1') return;

  // Mark done immediately so concurrent calls and restarts don't double-run.
  await setSetting('sent_attachment_repair_v2', '1');

  if (imapAccountIds.length === 0) return;

  const { getDb } = await import('../db/connection');
  const db = await getDb();

  const placeholders = imapAccountIds.map((_, i) => `$${i + 1}`).join(', ');
  const rows = await db.select<{ account_id: string; imap_folder: string; imap_uid: number }[]>(
    `SELECT m.account_id, m.imap_folder, m.imap_uid
     FROM messages m
     WHERE m.account_id IN (${placeholders})
       AND m.imap_uid IS NOT NULL
       AND m.imap_folder IS NOT NULL
       AND LOWER(m.imap_folder) LIKE '%sent%'
       AND NOT EXISTS (
         SELECT 1 FROM attachments a WHERE a.message_id = m.id
       )`,
    imapAccountIds,
  );

  if (rows.length === 0) return;

  console.log(`[repair] sentAttachments: found ${rows.length} message(s) to re-fetch`);

  // Group by account + folder to minimise IMAP connections.
  const groups = new Map<string, { accountId: string; folder: string; uids: number[] }>();
  for (const row of rows) {
    const key = `${row.account_id}:${row.imap_folder}`;
    if (!groups.has(key)) {
      groups.set(key, { accountId: row.account_id, folder: row.imap_folder, uids: [] });
    }
    groups.get(key)!.uids.push(row.imap_uid);
  }

  for (const { accountId, folder, uids } of groups.values()) {
    try {
      const account = await getAccount(accountId);
      if (!account) continue;
      const config = buildImapConfig(account);
      const folderMapping = mapFolderToLabel({
        path: folder, raw_path: folder, name: folder,
        delimiter: '/', special_use: null, exists: 0, unseen: 0,
        parent_path: null, has_children: false,
      });
      await fetchAllInBatches(config, accountId, folder, folderMapping.labelId, uids, 0);
      console.log(
        `[repair] sentAttachments: re-fetched ${uids.length} message(s) in ${folder} for account ${accountId}`,
      );
    } catch (err) {
      console.warn(`[repair] sentAttachments: failed for account ${accountId}:`, err);
    }
  }

  window.dispatchEvent(new Event('melo-sync-done'));
}

/**
 * v3: repair sent messages that still have no attachment rows after v2.
 * Uses the TypeScript IMAP fetch path (imapFetchMessageBody → upsertAttachment)
 * instead of the Rust imap_fetch_and_store path, which has a deduplication bug
 * that discards attachment rows when the message ID suffix doesn't match the
 * real server UID (common for APPENDUID-mismatch messages).
 *
 * Tracked by 'sent_attachment_repair_v3'.
 */
export async function repairSentAttachmentsV3(imapAccountIds: string[]): Promise<void> {
  const { getSetting: get, setSetting: set } = await import('../db/settings');
  const already = await get('sent_attachment_repair_v3');
  if (already === '1') return;

  // Do NOT mark done yet — only mark after the loop completes so a failed run
  // retries on the next startup rather than silently giving up forever.

  if (imapAccountIds.length === 0) {
    await set('sent_attachment_repair_v3', '1');
    return;
  }

  const { getDb } = await import('../db/connection');
  const db = await getDb();

  const placeholders = imapAccountIds.map((_, i) => `$${i + 1}`).join(', ');
  const rows = await db.select<{ id: string; account_id: string; imap_folder: string; imap_uid: number }[]>(
    `SELECT m.id, m.account_id, m.imap_folder, m.imap_uid
     FROM messages m
     WHERE m.account_id IN (${placeholders})
       AND m.imap_uid IS NOT NULL
       AND m.imap_folder IS NOT NULL
       AND LOWER(m.imap_folder) LIKE '%sent%'
       AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)
     LIMIT 30`,
    imapAccountIds,
  );

  if (rows.length === 0) {
    await set('sent_attachment_repair_v3', '1');
    return;
  }

  console.log(`[repair-v3] found ${rows.length} sent message(s) with missing attachment rows`);

  const { imapFetchMessageBody } = await import('./tauriCommands');
  const { upsertAttachment } = await import('../db/attachments');

  // Build config once per account
  const configCache = new Map<string, ReturnType<typeof buildImapConfig>>();
  let anyFixed = false;

  for (const row of rows) {
    try {
      let config = configCache.get(row.account_id);
      if (!config) {
        const account = await getAccount(row.account_id);
        if (!account) continue;
        config = buildImapConfig(account);
        configCache.set(row.account_id, config);
      }

      const imapMsg = await imapFetchMessageBody(config, row.imap_folder, row.imap_uid);
      if (imapMsg.attachments.length === 0) continue;

      for (const att of imapMsg.attachments) {
        await upsertAttachment({
          id: `${row.id}_${att.part_id}`,
          messageId: row.id,
          accountId: row.account_id,
          filename: att.filename,
          mimeType: att.mime_type,
          size: att.size,
          gmailAttachmentId: null,
          imapPartId: att.part_id,
          contentId: att.content_id,
          isInline: att.is_inline,
        });
      }
      anyFixed = true;
      console.log(`[repair-v3] stored ${imapMsg.attachments.length} attachment(s) for ${row.id}`);
    } catch (err) {
      console.warn(`[repair-v3] failed for ${row.id}:`, err);
    }
  }

  // Mark done only after the loop — retries on next startup if we never got here.
  await set('sent_attachment_repair_v3', '1');

  if (anyFixed) {
    window.dispatchEvent(new Event('melo-sync-done'));
  }
}

/** Accumulate cross-folder label data from a batch of headers. */
function _accumLabels(
  headers: ImapSyncHeader[],
  labelsByRfcId: Map<string, Set<string>>,
): void {
  for (const h of headers) {
    if (!h.message_id) continue;
    let labels = labelsByRfcId.get(h.message_id);
    if (!labels) { labels = new Set(); labelsByRfcId.set(h.message_id, labels); }
    labels.add(h.label_id);
    if (!h.is_read) labels.add("UNREAD");
    if (h.is_starred) labels.add("STARRED");
    if (h.is_draft) labels.add("DRAFT");
  }
}
