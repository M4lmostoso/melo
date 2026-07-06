import { createBackgroundChecker, type BackgroundChecker } from "../backgroundCheckers";
import { getDb } from "../db/connection";
import { getAccount } from "../db/accounts";
import { getSetting } from "../db/settings";
import { getEmailProvider } from "../email/providerFactory";
import { materializeEach, type AttachmentRef } from "./attachmentActions";
import { useUIStore } from "@/stores/uiStore";

const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024; // 5MB
const RECENT_DAYS = 7;
const BATCH_LIMIT = 20;

let checker: BackgroundChecker | null = null;
let isRunning = false;

async function preCacheRecent(): Promise<void> {
  // Prevent concurrent runs (React StrictMode double-init causes two simultaneous starts)
  if (isRunning) return;
  isRunning = true;
  try {
    await preCacheRecentInner();
  } finally {
    isRunning = false;
  }
}

async function preCacheRecentInner(): Promise<void> {
  if (!useUIStore.getState().isOnline) return;

  const db = await getDb();

  const sizeResult = await db.select<{ total: number | null }[]>(
    "SELECT SUM(cache_size) as total FROM attachments WHERE cached_at IS NOT NULL",
  );
  let runningSize = sizeResult[0]?.total ?? 0;

  const maxCacheMb = parseInt((await getSetting("attachment_cache_max_mb")) ?? "500", 10);
  const maxCacheBytes = maxCacheMb * 1024 * 1024;

  if (runningSize >= maxCacheBytes) return;

  // Pre-cache recent attachments for BOTH provider families:
  //
  // - Gmail: fetched via the Rust HTTP command straight into the cache (no
  //   base64 across the WebView bridge).
  // - IMAP: routed through the unified materializer (`materializeEach`), which
  //   groups by message and uses the raw-TCP batch command — one BODY.PEEK[]
  //   per message. The old blanket exclusion of IMAP is obsolete: it guarded
  //   against async-imap's per-fetch jemalloc buffering (2-3 GB footprint per
  //   run), but the raw-TCP batch path never touches async-imap and processes
  //   one message at a time with pages purged in between.
  const cutoff = Math.floor(Date.now() / 1000) - RECENT_DAYS * 24 * 60 * 60;
  const attachments = await db.select<{
    id: string;
    message_id: string;
    account_id: string;
    filename: string | null;
    size: number;
    gmail_attachment_id: string | null;
    imap_part_id: string | null;
  }[]>(
    `SELECT a.id, a.message_id, a.account_id, a.filename, a.size, a.gmail_attachment_id, a.imap_part_id
     FROM attachments a
     INNER JOIN messages m ON m.account_id = a.account_id AND m.id = a.message_id
     WHERE a.cached_at IS NULL
       AND a.is_inline = 0
       AND (a.gmail_attachment_id IS NOT NULL OR a.imap_part_id IS NOT NULL)
       AND a.size IS NOT NULL AND a.size <= $1
       AND m.date >= $2
     ORDER BY m.date DESC
     LIMIT $3`,
    [MAX_ATTACHMENT_SIZE, cutoff, BATCH_LIMIT],
  );

  if (attachments.length === 0) return;

  const imapRefs: AttachmentRef[] = [];

  for (const att of attachments) {
    if (runningSize + (att.size ?? 0) > maxCacheBytes) break;

    try {
      const account = await getAccount(att.account_id);
      if (!account) continue;

      if (account.imap_host) {
        if (att.imap_part_id) {
          imapRefs.push({
            dbId: att.id,
            accountId: att.account_id,
            messageId: att.message_id,
            attachmentId: att.imap_part_id,
            filename: att.filename,
            size: att.size,
          });
          runningSize += att.size ?? 0;
        }
        continue;
      }

      if (!att.gmail_attachment_id) continue;
      const provider = await getEmailProvider(att.account_id);

      if (provider.getValidToken) {
        const token = await provider.getValidToken();
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("gmail_fetch_and_cache_attachment", {
          accessToken: token,
          messageId: att.message_id,
          gmailAttachmentId: att.gmail_attachment_id,
          attachmentDbId: att.id
        });
      } else {
        // Fallback for non-Gmail or if token is unavailable
        const result = await provider.fetchAttachment(att.message_id, att.gmail_attachment_id);

        const base64 = result.data.includes("-") || result.data.includes("_")
          ? result.data.replace(/-/g, "+").replace(/_/g, "/")
          : result.data;

        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("cache_attachment_b64", { attId: att.id, base64Data: base64 });
      }

      runningSize += att.size ?? 0;
    } catch {
      // Silently skip — will retry next interval
    }

    // Yield to event loop between iterations: gives JavaScriptCore's GC a chance
    // to reclaim the base64 string and Uint8Array from the previous iteration
    // before the next one allocates. Without this, V8/JSC may defer GC until
    // the loop finishes, keeping all intermediate buffers alive simultaneously.
    await new Promise((r) => setTimeout(r, 0));
  }

  // IMAP refs go through the shared materializer in one shot: grouped by
  // message (one download per email), deduplicated against any in-flight
  // preview/drag work, and recorded in attachments.local_path when done.
  if (imapRefs.length > 0) {
    const results = await Promise.allSettled(
      [...materializeEach(imapRefs).values()],
    );
    const failures = results.filter((r) => r.status === "rejected").length;
    if (failures > 0) console.warn(`[preCache] ${failures}/${imapRefs.length} IMAP attachment(s) failed — will retry next interval`);
  }
}

const STARTUP_DELAY_MS = 2 * 60 * 1000; // 2 minutes — let app settle before pre-caching

export function startPreCacheManager(): void {
  if (checker) return;
  checker = createBackgroundChecker("AttachmentPreCache", preCacheRecent, 900_000);
  // Delay first run so it doesn't compete with app startup and initial sync
  setTimeout(() => checker?.start(), STARTUP_DELAY_MS);
}

export function stopPreCacheManager(): void {
  checker?.stop();
  checker = null;
}
