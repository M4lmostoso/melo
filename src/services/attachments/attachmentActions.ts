import { getEmailProvider } from "@/services/email/providerFactory";
import { getDb } from "@/services/db/connection";
import { evictOldestCached } from "./cacheManager";

/**
 * Minimal descriptor needed to materialize an attachment to disk. Both
 * `DbAttachment` (message view) and `AttachmentWithContext` (library) can be
 * mapped to this via {@link toAttachmentRef} since they share these fields.
 */
export interface AttachmentRef {
  dbId: string;
  accountId: string;
  messageId: string;
  /** Provider-specific id: gmail_attachment_id ?? imap_part_id. */
  attachmentId: string | null;
  filename: string | null;
  size: number | null;
}

type AttachmentRow = {
  id: string;
  account_id: string;
  message_id: string;
  gmail_attachment_id: string | null;
  imap_part_id: string | null;
  filename: string | null;
  size: number | null;
};

export function toAttachmentRef(a: AttachmentRow): AttachmentRef {
  return {
    dbId: a.id,
    accountId: a.account_id,
    messageId: a.message_id,
    attachmentId: a.gmail_attachment_id ?? a.imap_part_id,
    filename: a.filename,
    size: a.size,
  };
}

/** Legacy drag staging dir — no longer written to; cleaned up at startup. */
const DRAG_TEMP_DIR = "drag_temp";

/** Unified on-disk attachment cache, shared with cacheManager/CID resolver:
 * `attachment_cache/<hash(dbId)>/<real-file-name>`, tracked in
 * `attachments.local_path` and LRU-evicted by cacheManager. The real file name
 * in the leaf lets native drag-out expose it directly from the cache. */
const CACHE_DIR = "attachment_cache";

/**
 * Sanitize a filename for a real, user-visible download: strip path separators and
 * characters illegal on common filesystems, but keep spaces/unicode so the saved
 * name matches what the user sees. (Distinct from {@link safeFileName}, which is for
 * internal temp dirs and is more aggressive.)
 */
function sanitizeDownloadName(name: string | null): string {
  // eslint-disable-next-line no-control-regex
  const base = (name ?? "attachment").replace(/[/\\:*?"<>|\x00-\x1f]/g, "_").trim();
  return base.length > 0 ? base : "attachment";
}

/** Make `name` unique within `used`, inserting " (2)", " (3)", … before the extension. */
function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let i = 2;
  let candidate = `${stem} (${i})${ext}`;
  while (used.has(candidate)) candidate = `${stem} (${++i})${ext}`;
  used.add(candidate);
  return candidate;
}

export interface DownloadToFolderResult {
  ok: number;
  failed: number;
  /** Absolute path of the first successfully written file (for reveal-in-dir). */
  firstPath: string | null;
}

/** Per-file progress, fired just before each attachment starts downloading. */
export interface DownloadProgress {
  /** 0-based index of the file about to download. */
  index: number;
  /** Total number of files in the batch. */
  total: number;
  /** dbId of the current file — matches the `attachment-download-progress` event id. */
  dbId: string;
}

/**
 * Download several attachments into a user-chosen directory, each under its real
 * file name (de-duplicated within the batch). Reuses `provider.downloadAttachmentToPath`,
 * which streams Gmail/IMAP and inline attachments transparently.
 *
 * `onProgress` fires before each file so the caller can drive a progress bar; byte-level
 * progress within a file arrives separately via the Rust `attachment-download-progress`
 * event (keyed by dbId).
 */
export async function downloadAttachmentsToFolder(
  refs: AttachmentRef[],
  dir: string,
  onProgress?: (p: DownloadProgress) => void,
): Promise<DownloadToFolderResult> {
  const { join } = await import("@tauri-apps/api/path");
  const used = new Set<string>();
  let ok = 0;
  let failed = 0;
  let firstPath: string | null = null;

  // Assign a unique destination path to every downloadable ref up front, in the
  // caller's order (so the de-dup " (2)" suffixes stay deterministic).
  const items: { ref: AttachmentRef; dest: string }[] = [];
  for (const ref of refs) {
    if (!ref.attachmentId) {
      failed++;
      continue;
    }
    const dest = await join(dir, uniqueName(sanitizeDownloadName(ref.filename), used));
    items.push({ ref, dest });
  }

  let index = 0;

  // Reuse the unified cache first: attachments already on disk (prefetch,
  // pre-cache, CID resolver, previous sessions via DB local_path) or being
  // materialized right now by a hover warm-up are copied instead of re-fetched
  // — the prefetch IS the download, work is never doubled.
  const dbLocal = new Map<string, string>();
  if (items.length > 0) {
    try {
      const db = await getDb();
      const ids = items.map((it) => it.ref.dbId);
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
      const rows = await db.select<{ id: string; local_path: string | null }[]>(
        `SELECT id, local_path FROM attachments WHERE id IN (${placeholders}) AND local_path IS NOT NULL`,
        ids,
      );
      for (const r of rows) if (r.local_path) dbLocal.set(r.id, r.local_path);
    } catch {
      // best-effort — fall back to network
    }
  }

  const rest: { ref: AttachmentRef; dest: string }[] = [];
  for (const it of items) {
    let src: string | null = null;
    const inflight = materializePromises.get(it.ref.dbId);
    if (inflight) {
      // Report BEFORE awaiting: the in-flight fetch (e.g. a hover warm-up) can
      // take a while, and the progress UI must show which file we're on
      // instead of sitting at 0% in silence.
      onProgress?.({ index, total: items.length, dbId: it.ref.dbId });
      try {
        src = await inflight;
      } catch {
        src = null; // in-flight failed — fall through to a fresh fetch
      }
    } else if (dbLocal.has(it.ref.dbId)) {
      try {
        const { appDataDir } = await import("@tauri-apps/api/path");
        const { exists, stat } = await import("@tauri-apps/plugin-fs");
        const abs = await join(await appDataDir(), dbLocal.get(it.ref.dbId)!);
        if (await exists(abs)) {
          const info = await stat(abs);
          if (it.ref.size == null || info.size === it.ref.size) src = abs;
        }
      } catch {
        src = null;
      }
    }
    if (!src) {
      rest.push(it);
      continue;
    }
    onProgress?.({ index, total: items.length, dbId: it.ref.dbId });
    try {
      const { copyFile } = await import("@tauri-apps/plugin-fs");
      await copyFile(src, it.dest);
      ok++;
      if (!firstPath) firstPath = it.dest;
    } catch (err) {
      console.error("Copy from attachment cache failed:", err);
      failed++;
    }
    index++;
  }

  // Group by account+message so a provider that can serve a whole message from a
  // single fetch (IMAP) downloads each email once instead of once per attachment
  // — the DavMail per-part fetch is mangled into a near-full-message transfer, so
  // an N-attachment email otherwise cost ~N × the message.
  const groups = new Map<string, { ref: AttachmentRef; dest: string }[]>();
  const order: string[] = [];
  for (const it of rest) {
    const key = `${it.ref.accountId} ${it.ref.messageId}`;
    let g = groups.get(key);
    if (!g) {
      g = [];
      groups.set(key, g);
      order.push(key);
    }
    g.push(it);
  }

  for (const key of order) {
    const group = groups.get(key)!;
    const provider = await getEmailProvider(group[0]!.ref.accountId);

    if (provider.downloadAttachmentsBatch) {
      // Whole email in one fetch. Report progress at the file that starts the group.
      onProgress?.({ index, total: items.length, dbId: group[0]!.ref.dbId });
      try {
        const results = await provider.downloadAttachmentsBatch(
          group.map((it) => ({
            messageId: it.ref.messageId,
            attachmentId: it.ref.attachmentId!,
            destPath: it.dest,
            dbId: it.ref.dbId,
          })),
        );
        const byId = new Map(results.map((r) => [r.dbId, r]));
        for (const it of group) {
          const r = byId.get(it.ref.dbId);
          if (r?.ok) {
            ok++;
            if (!firstPath) firstPath = it.dest;
          } else {
            failed++;
            console.error("Download attachment failed:", r?.error ?? "unknown");
          }
        }
      } catch (err) {
        console.error("Batch download failed:", err);
        failed += group.length;
      }
      index += group.length;
    } else {
      // Fallback: per-file streaming (e.g. Gmail, whose per-attachment endpoint
      // is already efficient — no whole-message re-fetch).
      for (const it of group) {
        onProgress?.({ index, total: items.length, dbId: it.ref.dbId });
        try {
          await provider.downloadAttachmentToPath(
            it.ref.messageId,
            it.ref.attachmentId!,
            it.dest,
            it.ref.dbId,
            it.ref.size ?? 0,
          );
          ok++;
          if (!firstPath) firstPath = it.dest;
        } catch (err) {
          console.error("Download attachment failed:", err);
          failed++;
        }
        index++;
      }
    }
  }
  return { ok, failed, firstPath };
}

// Generic document drag puck (36×36 PNG). tauri-plugin-drag requires a valid
// `data:image/png;base64,` icon — an empty string fails deserialization.
export const DRAG_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAAAVElEQVR42u3YMQoAIAxD0R67oyfu4AWqi44iQkD0BzL7hnawZou4l1TUTnMdKKKmooAASUFj8lWP73ZuICBAgAABAgQIECBAgB4D8S8D9BWIC1pPA0EuZR5bGO8zAAAAAElFTkSuQmCC";

/** Strip path separators and characters that are unsafe in file names. */
function safeFileName(name: string | null): string {
  const base = (name ?? "attachment").replace(/[/\\:*?"<>| ]/g, "_").trim();
  return base.length > 0 ? base : "attachment";
}

/**
 * A short, stable, filesystem-safe directory name derived from the attachment's
 * dbId. Gmail rows use `${messageId}_${gmailAttachmentId}` as their id and the
 * Gmail attachment id can be hundreds of chars long — using it verbatim as a
 * directory name overflows the OS file-name limit (ENAMETOOLONG, errno 63 on
 * macOS). Hashing keeps the name short while staying deterministic so the
 * re-use/skip-download check still resolves to the same path.
 */
async function dirNameForDbId(dbId: string): Promise<string> {
  const bytes = new TextEncoder().encode(dbId);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest).slice(0, 16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Shared materialization layer
// ---------------------------------------------------------------------------
//
// Every consumer of attachment bytes-on-disk — drag-out prefetch, "download all",
// open-with-default-app — funnels through ONE single-flight registry. The same
// attachment is never fetched twice concurrently, finished work is reused within
// the session (files live under drag_temp until app restart), and requests
// arriving within a short window are coalesced so batch-capable providers (IMAP)
// fetch each message once for all its attachments instead of once per file.

/** Single-flight registry: attachment dbId → promise of its absolute cached path.
 * Successes stay (path is stable for the session); failures are evicted so a
 * retry can start fresh. */
const materializePromises = new Map<string, Promise<string>>();

interface MaterializeTodo {
  ref: AttachmentRef;
  resolve: (path: string) => void;
  reject: (err: unknown) => void;
}

let materializeQueue: MaterializeTodo[] = [];
let materializeFlushTimer: ReturnType<typeof setTimeout> | null = null;

/** Coalescing window: hover-sweeping N attachments of the same email within this
 * window becomes ONE batched fetch instead of N single-part fetches. */
const MATERIALIZE_COALESCE_MS = 80;

/** Max concurrent message fetches across all coalescing flushes. Hover-sweeping
 * a list must never open a connection storm toward the server — on DavMail each
 * fetch is a full-message transfer and parallel storms saturate the link,
 * starving every other fetch into timeout. */
const MAX_CONCURRENT_GROUP_FETCHES = 2;
let activeGroupFetches = 0;
let groupFetchWaiters: (() => void)[] = [];

async function withGroupFetchSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (activeGroupFetches >= MAX_CONCURRENT_GROUP_FETCHES) {
    await new Promise<void>((r) => groupFetchWaiters.push(r));
  }
  activeGroupFetches++;
  try {
    return await fn();
  } finally {
    activeGroupFetches--;
    groupFetchWaiters.shift()?.();
  }
}

/** Skip whole-message expansion for enormous siblings (they'd churn the LRU cache). */
const MAX_EXPANSION_SIZE = 25 * 1024 * 1024;

/** Test-only: clear module-level materialization state between tests. */
export function _resetMaterializeStateForTests(): void {
  materializePromises.clear();
  materializeQueue = [];
  if (materializeFlushTimer) {
    clearTimeout(materializeFlushTimer);
    materializeFlushTimer = null;
  }
  activeGroupFetches = 0;
  groupFetchWaiters = [];
}

/**
 * Ensure each attachment is (being) materialized to the drag_temp cache and
 * return a per-dbId promise of its absolute path. Already-cached and in-flight
 * attachments resolve to the same shared promise — callers can subscribe to
 * per-file completion without ever duplicating network work.
 */
export function materializeEach(refs: AttachmentRef[]): Map<string, Promise<string>> {
  const out = new Map<string, Promise<string>>();
  for (const ref of refs) {
    if (out.has(ref.dbId)) continue;
    const existing = materializePromises.get(ref.dbId);
    if (existing) {
      out.set(ref.dbId, existing);
      continue;
    }
    if (!ref.attachmentId) {
      const p = Promise.reject(new Error("Attachment has no downloadable id"));
      p.catch(() => {}); // mark handled — not registered, nothing to share
      out.set(ref.dbId, p);
      continue;
    }
    let resolve!: (v: string) => void;
    let reject!: (e: unknown) => void;
    const p = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
    p.catch(() => { materializePromises.delete(ref.dbId); }); // evict failures → retry possible
    materializePromises.set(ref.dbId, p);
    out.set(ref.dbId, p);
    materializeQueue.push({ ref, resolve, reject });
  }
  if (materializeQueue.length > 0 && !materializeFlushTimer) {
    materializeFlushTimer = setTimeout(() => {
      materializeFlushTimer = null;
      const batch = materializeQueue;
      materializeQueue = [];
      void runMaterializeBatch(batch);
    }, MATERIALIZE_COALESCE_MS);
  }
  return out;
}

/** Best-effort DB bookkeeping after a file lands in the cache: record the
 * relative path so every consumer (preview, drag, download, pre-cache) finds it,
 * and kick LRU eviction. Never fails the materialization itself. */
async function recordCached(dbId: string, relPath: string, sizeOnDisk: number | null): Promise<void> {
  try {
    const db = await getDb();
    await db.execute(
      "UPDATE attachments SET local_path = $1, cached_at = unixepoch(), cache_size = $2 WHERE id = $3",
      [relPath, sizeOnDisk, dbId],
    );
    evictOldestCached().catch(() => {});
  } catch (err) {
    console.warn("Attachment cache bookkeeping failed:", err);
  }
}

/** Drain one coalesced queue: resolve cache hits, then fetch the rest grouped by
 * account+message (batch-capable providers download each message exactly once).
 *
 * Everything lands in the SAME store the CID resolver and pre-cache use:
 * `attachment_cache/<hash>/<real-name>` on disk + `attachments.local_path` in
 * the DB (LRU-evicted via cacheManager). One copy of the bytes serves preview,
 * drag-out, download-to-folder and open-with-app. */
async function runMaterializeBatch(todo: MaterializeTodo[]): Promise<void> {
  let appData: string;
  let joinFn: (...paths: string[]) => Promise<string>;
  let fs: typeof import("@tauri-apps/plugin-fs");
  try {
    const [pathApi, fsApi] = await Promise.all([
      import("@tauri-apps/api/path"),
      import("@tauri-apps/plugin-fs"),
    ]);
    appData = await pathApi.appDataDir();
    joinFn = pathApi.join;
    fs = fsApi;
  } catch (err) {
    for (const t of todo) t.reject(err);
    return;
  }

  // Existing cache entries from the DB (covers previous sessions, the CID
  // resolver and the Gmail pre-cache — not just this session's registry).
  const localPaths = new Map<string, string>();
  try {
    const db = await getDb();
    const ids = todo.map((t) => t.ref.dbId);
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
    const rows = await db.select<{ id: string; local_path: string | null }[]>(
      `SELECT id, local_path FROM attachments WHERE id IN (${placeholders}) AND local_path IS NOT NULL`,
      ids,
    );
    for (const r of rows) if (r.local_path) localPaths.set(r.id, r.local_path);
  } catch {
    // DB lookup best-effort — worst case we re-download
  }

  // Resolve each item's cache path; serve disk hits without any network.
  const pending: { t: MaterializeTodo; dest: string; relPath: string }[] = [];
  for (const t of todo) {
    try {
      const relDir = `${CACHE_DIR}/${await dirNameForDbId(t.ref.dbId)}`;
      const relPath = `${relDir}/${safeFileName(t.ref.filename)}`;
      const dest = await joinFn(appData, relPath);

      // 1. Reuse whatever local_path the DB already records (any layout —
      //    legacy flat CID/pre-cache names included). Migrate legacy entries
      //    into the named layout so native drag exposes the real filename.
      const known = localPaths.get(t.ref.dbId);
      let served = false;
      if (known) {
        try {
          const knownAbs = await joinFn(appData, known);
          if (await fs.exists(knownAbs)) {
            const info = await fs.stat(knownAbs);
            if (t.ref.size == null || info.size === t.ref.size) {
              if (known === relPath) {
                t.resolve(knownAbs);
              } else {
                await fs.mkdir(await joinFn(appData, relDir), { recursive: true });
                await fs.copyFile(knownAbs, dest);
                await recordCached(t.ref.dbId, relPath, info.size);
                fs.remove(knownAbs).catch(() => {});
                t.resolve(dest);
              }
              served = true;
            }
          }
        } catch {
          // fall through to the direct disk probe / download
        }
      }
      if (served) continue;

      // 2. Direct disk probe at the canonical location (DB row may have been
      //    lost while the file survived).
      await fs.mkdir(await joinFn(appData, relDir), { recursive: true });
      try {
        if (await fs.exists(dest)) {
          const info = await fs.stat(dest);
          if (t.ref.size == null || info.size === t.ref.size) {
            await recordCached(t.ref.dbId, relPath, info.size);
            t.resolve(dest);
            continue;
          }
        }
      } catch {
        // stat/exists best-effort — fall through to (re)download
      }
      pending.push({ t, dest, relPath });
    } catch (err) {
      t.reject(err);
    }
  }
  if (pending.length === 0) return;

  const groups = new Map<string, { t: MaterializeTodo; dest: string; relPath: string }[]>();
  for (const item of pending) {
    const key = `${item.t.ref.accountId}\n${item.t.ref.messageId}`;
    const g = groups.get(key);
    if (g) g.push(item);
    else groups.set(key, [item]);
  }

  // Record + resolve one downloaded file (stat is best-effort for cache_size).
  const finish = async (t: MaterializeTodo, dest: string, relPath: string) => {
    let sizeOnDisk: number | null = t.ref.size;
    try {
      sizeOnDisk = (await fs.stat(dest)).size;
    } catch {
      // keep the declared size
    }
    await recordCached(t.ref.dbId, relPath, sizeOnDisk);
    t.resolve(dest);
  };

  for (const group of groups.values()) {
    let provider;
    try {
      provider = await getEmailProvider(group[0]!.t.ref.accountId);
    } catch (err) {
      for (const { t } of group) t.reject(err);
      continue;
    }

    if (provider.downloadAttachmentsBatch) {
      // Thunderbird model: the unit of transfer is the MESSAGE. The batch
      // fetch downloads the whole message anyway, so expand the group to every
      // not-yet-cached attachment of that message and slice them all from the
      // single download — this message never needs fetching again. (Without
      // this, hovering attachments one at a time re-downloaded the entire
      // message once per attachment.)
      try {
        const db = await getDb();
        const first = group[0]!.t.ref;
        const siblings = await db.select<{
          id: string;
          imap_part_id: string | null;
          filename: string | null;
          size: number | null;
          local_path: string | null;
        }[]>(
          "SELECT id, imap_part_id, filename, size, local_path FROM attachments WHERE account_id = $1 AND message_id = $2",
          [first.accountId, first.messageId],
        );
        for (const s of siblings) {
          if (!s.imap_part_id) continue;
          if (s.local_path) continue; // already cached
          if (materializePromises.has(s.id)) continue; // requested or in flight
          if (s.size != null && s.size > MAX_EXPANSION_SIZE) continue;
          let resolve!: (v: string) => void;
          let reject!: (e: unknown) => void;
          const p = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
          p.catch(() => materializePromises.delete(s.id));
          materializePromises.set(s.id, p);
          const ref: AttachmentRef = {
            dbId: s.id,
            accountId: first.accountId,
            messageId: first.messageId,
            attachmentId: s.imap_part_id,
            filename: s.filename,
            size: s.size,
          };
          const relDir = `${CACHE_DIR}/${await dirNameForDbId(s.id)}`;
          const relPath = `${relDir}/${safeFileName(s.filename)}`;
          await fs.mkdir(await joinFn(appData, relDir), { recursive: true });
          group.push({ t: { ref, resolve, reject }, dest: await joinFn(appData, relPath), relPath });
        }
      } catch {
        // expansion is best-effort — the requested parts still download
      }

      await withGroupFetchSlot(async () => {
        try {
          const results = await provider.downloadAttachmentsBatch!(
            group.map(({ t, dest }) => ({
              messageId: t.ref.messageId,
              attachmentId: t.ref.attachmentId!,
              destPath: dest,
              dbId: t.ref.dbId,
            })),
          );
          const byId = new Map(results.map((r) => [r.dbId, r]));
          for (const { t, dest, relPath } of group) {
            const r = byId.get(t.ref.dbId);
            if (r?.ok) await finish(t, dest, relPath);
            else t.reject(new Error(r?.error ?? "download failed"));
          }
        } catch (err) {
          for (const { t } of group) t.reject(err);
        }
      });
    } else {
      // Per-file with a small concurrency cap — efficient per-attachment
      // endpoints (Gmail) don't need whole-message batching.
      await withGroupFetchSlot(async () => {
        const CONCURRENCY = 4;
        let next = 0;
        const worker = async () => {
          while (next < group.length) {
            const { t, dest, relPath } = group[next++]!;
            try {
              await provider.downloadAttachmentToPath(
                t.ref.messageId,
                t.ref.attachmentId!,
                dest,
                t.ref.dbId,
                t.ref.size ?? 0,
              );
              await finish(t, dest, relPath);
            } catch (err) {
              t.reject(err);
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, group.length) }, worker));
      });
    }
  }
}

/**
 * Ensure an attachment exists on disk in the unified cache
 * (`attachment_cache/<hash>/<name>`) and return the absolute path. Shares work
 * with any concurrent materialization of the same attachment (drag prefetch,
 * batch download, preview) via the single-flight registry.
 */
export async function materializeAttachment(ref: AttachmentRef): Promise<string> {
  return materializeEach([ref]).get(ref.dbId)!;
}

/** Materialize many attachments, preserving order. Attachments of the same
 * message are fetched together (one download per message on IMAP). */
export async function materializeMany(refs: AttachmentRef[]): Promise<string[]> {
  const map = materializeEach(refs);
  return Promise.all(refs.map((r) => map.get(r.dbId)!));
}

/** Open an attachment with the OS default application (e.g. .docx → Word). */
export async function openAttachmentWithDefaultApp(ref: AttachmentRef): Promise<void> {
  const path = await materializeAttachment(ref);
  const { openPath } = await import("@tauri-apps/plugin-opener");
  await openPath(path);
}

/**
 * Start a native OS drag for files already materialized on disk. Kept separate
 * from materialization so callers can pre-materialize on press and fire the drag
 * with zero latency once the pointer starts moving (see useDragOut).
 */
export async function dragPaths(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const { startDrag } = await import("@crabnebula/tauri-plugin-drag");
  await startDrag({ item: paths, icon: DRAG_ICON });
}

/** Pre-import the native drag module so the first real drag has no import latency. */
export function warmDragModule(): void {
  void import("@crabnebula/tauri-plugin-drag");
}

/**
 * Start a native OS drag for one or more attachments so they can be dropped on
 * the Desktop, a Finder folder, Downloads, etc. Files are materialized to disk
 * first (their absolute paths are required by the native drag session).
 */
export async function startAttachmentDrag(refs: AttachmentRef[]): Promise<void> {
  const draggable = refs.filter((r) => r.attachmentId);
  if (draggable.length === 0) return;
  const paths = await materializeMany(draggable);
  await dragPaths(paths);
}

/** Remove the drag-temp directory. Best-effort; safe to call on startup. */
export async function cleanupDragTemp(): Promise<void> {
  try {
    const { appDataDir, join } = await import("@tauri-apps/api/path");
    const { remove } = await import("@tauri-apps/plugin-fs");
    const dir = await join(await appDataDir(), DRAG_TEMP_DIR);
    await remove(dir, { recursive: true });
  } catch {
    // directory may not exist — ignore
  }
}
