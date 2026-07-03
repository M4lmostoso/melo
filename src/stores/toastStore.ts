import { create } from "zustand";

export interface Toast {
  id: string;
  kind: "error" | "warning" | "info";
  message: string;
  createdAt: number;
}

interface ToastState {
  toasts: Toast[];
  /** Show a toast; auto-dismissed by ToastHost after a few seconds. */
  showToast: (kind: Toast["kind"], message: string) => void;
  dismissToast: (id: string) => void;
}

/**
 * Minimal global toast channel for background failures that would otherwise be
 * invisible in-app (OS notifications can be blocked). Not a general-purpose
 * notification system — use sparingly for actionable errors.
 */
export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  showToast: (kind, message) =>
    set((s) => {
      // Collapse duplicates: re-showing the same message refreshes it instead
      // of stacking copies (e.g. a retry loop failing every 30s).
      const existing = s.toasts.filter((t) => t.message !== message);
      return {
        toasts: [
          ...existing,
          { id: crypto.randomUUID(), kind, message, createdAt: Date.now() },
        ].slice(-4),
      };
    }),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
