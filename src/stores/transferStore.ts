import { create } from "zustand";

export interface TransferProgress {
  /** Human-readable destination, e.g. the target account address. */
  target: string;
  done: number;
  total: number;
  currentSubject: string | null;
}

interface TransferState {
  progress: TransferProgress | null;
  startTransfer: (target: string, total: number) => void;
  updateTransfer: (done: number, total: number, currentSubject?: string | null) => void;
  endTransfer: () => void;
}

/**
 * Progress channel for the cross-account move (drag & drop of threads onto
 * another account). The move is a raw fetch + APPEND + delete per message and
 * can run for minutes; without this the UI was completely silent and the
 * threads only vanished once everything had finished.
 */
export const useTransferStore = create<TransferState>((set) => ({
  progress: null,
  startTransfer: (target, total) =>
    set({ progress: { target, done: 0, total, currentSubject: null } }),
  updateTransfer: (done, total, currentSubject = null) =>
    set((s) => ({
      progress: s.progress ? { ...s.progress, done, total, currentSubject } : s.progress,
    })),
  endTransfer: () => set({ progress: null }),
}));
