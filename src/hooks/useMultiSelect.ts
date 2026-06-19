import { useState, useCallback, useRef } from "react";

/** Modifier keys read from a mouse event (subset, for testability). */
export interface ClickModifiers {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

export interface MultiSelect {
  selectedIds: Set<string>;
  /** The last item interacted with (used as the keyboard/preview target). */
  activeId: string | null;
  isSelected: (id: string) => boolean;
  /** Finder-style click handling: plain = single, ⌘/Ctrl = toggle, Shift = range. */
  onItemClick: (id: string, e: ClickModifiers) => void;
  /** Replace the selection with a single item. */
  selectOnly: (id: string) => void;
  clear: () => void;
}

/**
 * Finder-style multi-selection over an ordered list of ids.
 *
 * `orderedIds` must reflect the current display order so Shift-range selection
 * spans the visible items. The hook reads the latest order at click time, so it
 * stays correct as the list filters/sorts.
 */
export function useMultiSelect(orderedIds: string[]): MultiSelect {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const anchorRef = useRef<string | null>(null);
  const orderRef = useRef(orderedIds);
  orderRef.current = orderedIds;

  const selectOnly = useCallback((id: string) => {
    setSelectedIds(new Set([id]));
    setActiveId(id);
    anchorRef.current = id;
  }, []);

  const clear = useCallback(() => {
    setSelectedIds(new Set());
    setActiveId(null);
    anchorRef.current = null;
  }, []);

  const onItemClick = useCallback((id: string, e: ClickModifiers) => {
    const order = orderRef.current;
    const anchor = anchorRef.current;

    if (e.shiftKey && anchor) {
      const a = order.indexOf(anchor);
      const b = order.indexOf(id);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelectedIds(new Set(order.slice(lo, hi + 1)));
        setActiveId(id);
        return;
      }
    }

    if (e.metaKey || e.ctrlKey) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      anchorRef.current = id;
      setActiveId(id);
      return;
    }

    selectOnly(id);
  }, [selectOnly]);

  const isSelected = useCallback((id: string) => selectedIds.has(id), [selectedIds]);

  return { selectedIds, activeId, isSelected, onItemClick, selectOnly, clear };
}
