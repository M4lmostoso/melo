import { useRef, useCallback } from "react";
import type { AttachmentRef } from "@/services/attachments/attachmentActions";
import { materializeMany, dragPaths, DRAG_ICON } from "@/services/attachments/attachmentActions";

type StartDragFn = (opts: { item: string[]; icon: string }) => Promise<void>;

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
 * `resolveRefs(id)` returns the attachments to drag for the pressed item
 * (selection-aware: the whole selection when the item is selected, else itself).
 */
export function useDragOut(resolveRefs: (id: string) => AttachmentRef[]) {
  const pathsRef = useRef<string[] | null>(null);
  const pathsPromiseRef = useRef<Promise<string[]> | null>(null);
  const startDragRef = useRef<StartDragFn | null>(null);
  const draggedRef = useRef(false);
  const resolveR = useRef(resolveRefs);
  resolveR.current = resolveRefs;

  const warmUp = useCallback((id: string) => {
    const refs = resolveR.current(id).filter((r) => r.attachmentId);
    pathsRef.current = null;
    const p = materializeMany(refs)
      .then((paths) => { pathsRef.current = paths; return paths; })
      .catch(() => [] as string[]);
    pathsPromiseRef.current = p;
    if (!startDragRef.current) {
      import("@crabnebula/tauri-plugin-drag")
        .then((m) => { startDragRef.current = m.startDrag as StartDragFn; })
        .catch(() => {});
    }
  }, []);

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

    if (pathsRef.current) {
      fire(pathsRef.current);
    } else if (pathsPromiseRef.current) {
      pathsPromiseRef.current.then(fire);
    } else {
      // dragstart without a prior mousedown warm-up — materialize now.
      const refs = resolveR.current(id).filter((r) => r.attachmentId);
      materializeMany(refs).then(fire).catch((err) => console.error("Attachment drag failed:", err));
    }
  }, [fire]);

  /** True when the last gesture became a drag — use to suppress the click. */
  const didDrag = useCallback(() => draggedRef.current, []);

  return { onItemMouseDown, onItemDragStart, didDrag };
}
