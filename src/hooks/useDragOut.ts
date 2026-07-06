import { useRef, useCallback, useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import type { AttachmentRef } from "@/services/attachments/attachmentActions";
import { materializeEach, dragPaths, DRAG_ICON } from "@/services/attachments/attachmentActions";

type StartDragFn = (opts: { item: string[]; icon: string }) => Promise<void>;

/** Per-attachment drag-readiness, keyed by the attachment db id. */
export type DragPrepState = "preparing" | "ready" | "error";

/** Warm-up entry for one item id: resolved paths once every ref settled. */
interface WarmEntry {
  paths: string[] | null;
  promise: Promise<string[]>;
}

/**
 * Native file drag-out for attachments.
 *
 * Uses the canonical pattern (same as Electron's `webContents.startDrag`):
 * HTML5 `draggable` + `dragstart` → `preventDefault()` → start the native drag.
 * The drag MUST be kicked off synchronously inside `dragstart` (that is the only
 * moment AppKit/WebKit is in a drag-tracking context), so the files are
 * materialized to disk eagerly on `mousedown` and the plugin module is
 * pre-imported — leaving `dragstart` free of any blocking await.
 *
 * Warm-ups are tracked per item id (a Map, not a single slot): hovering item B
 * while item A is still preparing no longer abandons A. The heavy lifting is
 * shared through the module-level single-flight registry in attachmentActions,
 * so re-hovering and overlapping selections never duplicate a download.
 *
 * `resolveRefs(id)` returns the attachments to drag for the pressed item
 * (selection-aware: the whole selection when the item is selected, else itself).
 */
export function useDragOut(resolveRefs: (id: string) => AttachmentRef[]) {
  const warmRef = useRef(new Map<string, WarmEntry>());
  const startDragRef = useRef<StartDragFn | null>(null);
  const draggedRef = useRef(false);
  const resolveR = useRef(resolveRefs);
  resolveR.current = resolveRefs;

  // Drag-readiness per attachment db id (drives the UI indicator) and live
  // download percentage (0–100) sourced from the Rust progress event.
  const [prepState, setPrepState] = useState<Record<string, DragPrepState>>({});
  const [progress, setProgress] = useState<Record<string, number>>({});

  useEffect(() => {
    type ProgressPayload = { attachmentId: string; downloaded: number; total: number };
    const unlisten = listen<ProgressPayload>("attachment-download-progress", (e) => {
      const { attachmentId, downloaded, total } = e.payload;
      const pct = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
      setProgress((prev) => ({ ...prev, [attachmentId]: pct }));
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  // Materialize the attachment(s) for `id` to disk so their paths are ready by
  // the time `dragstart` fires (the native drag must start synchronously there).
  // Always re-resolves the refs (selection may have changed since the last
  // warm-up); the single-flight registry makes repeated calls free.
  const warmUp = useCallback((id: string) => {
    const refs = resolveR.current(id).filter((r) => r.attachmentId);
    if (refs.length === 0) return;

    const promises = materializeEach(refs);

    // Mark "preparing" only what isn't already on disk — never regress "ready".
    setPrepState((prev) => {
      const next = { ...prev };
      for (const r of refs) {
        if (next[r.dbId] !== "ready") next[r.dbId] = "preparing";
      }
      return next;
    });
    for (const r of refs) {
      promises.get(r.dbId)!
        .then(() => setPrepState((prev) => (prev[r.dbId] === "ready" ? prev : { ...prev, [r.dbId]: "ready" })))
        .catch(() => setPrepState((prev) => ({ ...prev, [r.dbId]: "error" })));
    }

    // Paths for the native drag. Tolerate partial failure: drag whatever
    // materialized — failed items keep their per-item error indicator.
    const entry: WarmEntry = {
      paths: null,
      promise: Promise.allSettled(refs.map((r) => promises.get(r.dbId)!)).then((settled) => {
        const paths = settled
          .filter((s): s is PromiseFulfilledResult<string> => s.status === "fulfilled")
          .map((s) => s.value);
        entry.paths = paths;
        return paths;
      }),
    };
    warmRef.current.set(id, entry);

    if (!startDragRef.current) {
      import("@crabnebula/tauri-plugin-drag")
        .then((m) => { startDragRef.current = m.startDrag as StartDragFn; })
        .catch(() => {});
    }
  }, []);

  // Begin materializing as soon as the pointer enters the item — gives slow IMAP
  // downloads a head start so the file is on disk before the drag is initiated.
  const onItemPointerEnter = useCallback((id: string) => {
    warmUp(id);
  }, [warmUp]);

  const fire = useCallback((paths: string[]) => {
    if (!paths.length) return;
    const fn = startDragRef.current;
    if (fn) {
      fn({ item: paths, icon: DRAG_ICON }).catch((err) => console.error("Attachment drag failed:", err));
    } else {
      // Module not loaded yet — fall back to the dynamic-import path.
      dragPaths(paths).catch((err) => console.error("Attachment drag failed:", err));
    }
  }, []);

  // Begin materializing as soon as the user presses, so paths are ready by dragstart.
  const onItemMouseDown = useCallback((id: string, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    draggedRef.current = false;
    warmUp(id);
  }, [warmUp]);

  // Fire the native drag synchronously within dragstart (no blocking await).
  const onItemDragStart = useCallback((id: string, e: React.DragEvent) => {
    e.preventDefault();
    draggedRef.current = true;
    setTimeout(() => { draggedRef.current = false; }, 0);

    let entry = warmRef.current.get(id);
    if (!entry) {
      // dragstart without a prior warm-up (e.g. keyboard-initiated) — start now.
      warmUp(id);
      entry = warmRef.current.get(id);
    }
    if (!entry) return;
    if (entry.paths) {
      fire(entry.paths);
    } else {
      entry.promise.then(fire);
    }
  }, [fire, warmUp]);

  /** True when the last gesture became a drag — use to suppress the click. */
  const didDrag = useCallback(() => draggedRef.current, []);

  return { onItemPointerEnter, onItemMouseDown, onItemDragStart, didDrag, prepState, progress };
}
