import { create } from "zustand";

export interface TransferProgress {
  /** Stable id, so concurrent transfers update their own row. */
  id: string;
  /** Human-readable destination, e.g. the target account address. */
  target: string;
  done: number;
  total: number;
  currentSubject: string | null;
}

interface TransferState {
  transfers: TransferProgress[];
  /** Registers a transfer and returns its id — pass it to update/end. */
  startTransfer: (target: string, total: number) => string;
  updateTransfer: (id: string, done: number, total: number, currentSubject?: string | null) => void;
  endTransfer: (id: string) => void;
}

/**
 * Progress channel for cross-account moves (drag & drop of threads onto another
 * account). A move is a raw fetch + APPEND + delete per message and can run for
 * minutes; without this the UI was completely silent and the threads only
 * vanished once everything had finished.
 *
 * Transfers are kept as a list, in start order: dropping a second batch while
 * the first is still running used to overwrite the single progress slot, so the
 * UI showed one transfer and silently hid the rest.
 */
export const useTransferStore = create<TransferState>((set) => ({
  transfers: [],
  startTransfer: (target, total) => {
    const id = crypto.randomUUID();
    set((s) => ({
      transfers: [...s.transfers, { id, target, done: 0, total, currentSubject: null }],
    }));
    return id;
  },
  updateTransfer: (id, done, total, currentSubject = null) =>
    set((s) => ({
      transfers: s.transfers.map((tr) =>
        tr.id === id ? { ...tr, done, total, currentSubject } : tr,
      ),
    })),
  endTransfer: (id) => set((s) => ({ transfers: s.transfers.filter((tr) => tr.id !== id) })),
}));
