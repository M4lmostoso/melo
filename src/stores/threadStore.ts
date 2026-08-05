import { create } from "zustand";

export interface Thread {
  id: string;
  accountId: string;
  subject: string | null;
  snippet: string | null;
  lastMessageAt: number;
  messageCount: number;
  unreadCount: number;
  isRead: boolean;
  isStarred: boolean;
  isPinned: boolean;
  isMuted: boolean;
  hasAttachments: boolean;
  labelIds: string[];
  fromName: string | null;
  fromAddress: string | null;
  allSenders?: string | null;
  allRecipients?: string | null;
  urgencyScore?: number;
  sentimentScore?: number;
  isHeatExtinguished?: boolean;
  /** Brief AI rationale for the urgency score (in the configured AI language), if available. */
  urgencyReason?: string | null;
  /** True when the score was lowered by a partial (non-closing) reply. */
  urgencyReplyDecayed?: boolean;
  /**
   * For Drafts-view rows, `id` is the draft MESSAGE id and this carries the parent
   * thread id (for resuming/deleting the draft). For all other rows it equals `id`.
   */
  threadIdReal?: string | null;
}

interface ThreadState {
  threads: Thread[];
  threadMap: Map<string, Thread>;
  selectedThreadId: string | null;
  selectedThreadIds: Set<string>;
  selectedMessageId: string | null;
  isLoading: boolean;
  searchQuery: string;
  searchThreadIds: Set<string> | null; // null = no active search
  searchResults: Thread[] | null; // null = no active search, [] = search returned no hits
  searchLoading: boolean;
  /**
   * Ids of the threads the list is actually rendering, in render order — published
   * by EmailList. Range/select-all operate on THIS list, not on `threads`: with a
   * search (or a read filter) active the visible rows are a subset, and spanning
   * `threads` silently selected rows the user could not see.
   * Empty means "nothing published" → fall back to `threads`.
   */
  visibleThreadIds: string[];
  setVisibleThreadIds: (ids: string[]) => void;
  setThreads: (threads: Thread[]) => void;
  selectThread: (id: string | null) => void;
  setSelectedMessageId: (id: string | null) => void;
  toggleThreadSelection: (id: string) => void;
  selectThreadRange: (id: string) => void;
  clearMultiSelect: () => void;
  selectAll: () => void;
  selectAllFromHere: () => void;
  setLoading: (loading: boolean) => void;
  updateThread: (id: string, updates: Partial<Thread>) => void;
  removeThread: (id: string) => void;
  removeThreads: (ids: string[]) => void;
  setSearch: (query: string, threadIds: Set<string> | null) => void;
  setSearchResults: (results: Thread[] | null) => void;
  setSearchLoading: (loading: boolean) => void;
  clearSearch: () => void;
  addThreads: (newThreads: Thread[]) => void;
  mergeSemanticResults: (results: Thread[]) => void;
}

/** The list selection actions walk: what is on screen, or every thread if unpublished. */
function selectionOrder(state: ThreadState): string[] {
  return state.visibleThreadIds.length > 0
    ? state.visibleThreadIds
    : state.threads.map((t) => t.id);
}

export const useThreadStore = create<ThreadState>((set, get) => ({
  threads: [],
  visibleThreadIds: [],
  threadMap: new Map(),
  selectedThreadId: null,
  selectedThreadIds: new Set(),
  selectedMessageId: null,
  isLoading: false,
  searchQuery: "",
  searchThreadIds: null,
  searchResults: null,
  searchLoading: false,

  setThreads: (threads) => set({ threads, threadMap: new Map(threads.map((t) => [t.id, t])) }),
  selectThread: (selectedThreadId) => set({ selectedThreadId, selectedThreadIds: new Set() }),
  setSelectedMessageId: (selectedMessageId) => set({ selectedMessageId }),
  toggleThreadSelection: (id) =>
    set((state) => {
      const next = new Set(state.selectedThreadIds);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return { selectedThreadIds: next };
    }),
  setVisibleThreadIds: (visibleThreadIds) => set({ visibleThreadIds }),
  selectThreadRange: (id) => {
    const state = get();
    const order = selectionOrder(state);
    // Find the anchor: last selected thread or the currently viewed thread
    const anchor = state.selectedThreadId ?? [...state.selectedThreadIds].pop();
    if (!anchor) {
      set({ selectedThreadIds: new Set([id]) });
      return;
    }
    const anchorIdx = order.indexOf(anchor);
    const targetIdx = order.indexOf(id);
    if (targetIdx === -1) return;
    // Anchor scrolled out of the current view (e.g. it is not part of the search
    // results): there is no range to span, so just add the clicked thread.
    if (anchorIdx === -1) {
      set((s) => ({ selectedThreadIds: new Set([...s.selectedThreadIds, id]) }));
      return;
    }
    const start = Math.min(anchorIdx, targetIdx);
    const end = Math.max(anchorIdx, targetIdx);
    const rangeIds = order.slice(start, end + 1);
    set((s) => ({
      selectedThreadIds: new Set([...s.selectedThreadIds, ...rangeIds]),
    }));
  },
  clearMultiSelect: () => set({ selectedThreadIds: new Set() }),
  selectAll: () => {
    set({ selectedThreadIds: new Set(selectionOrder(get())) });
  },
  selectAllFromHere: () => {
    const state = get();
    const order = selectionOrder(state);
    const idx = order.indexOf(state.selectedThreadId ?? "");
    const startIdx = idx === -1 ? 0 : idx;
    const ids = order.slice(startIdx);
    set((s) => ({
      selectedThreadIds: new Set([...s.selectedThreadIds, ...ids]),
    }));
  },
  setLoading: (isLoading) => set({ isLoading }),
  updateThread: (id, updates) =>
    set((state) => {
      const threads = state.threads.map((t) =>
        t.id === id ? { ...t, ...updates } : t,
      );
      const threadMap = new Map(state.threadMap);
      const existing = threadMap.get(id);
      if (existing) threadMap.set(id, { ...existing, ...updates });
      const searchResults = state.searchResults
        ? state.searchResults.map((t) => t.id === id ? { ...t, ...updates } : t)
        : null;
      return { threads, threadMap, searchResults };
    }),
  removeThread: (id) =>
    set((state) => {
      const threadMap = new Map(state.threadMap);
      threadMap.delete(id);
      const next = new Set(state.selectedThreadIds);
      next.delete(id);
      return {
        threads: state.threads.filter((t) => t.id !== id),
        threadMap,
        selectedThreadId: state.selectedThreadId === id ? null : state.selectedThreadId,
        selectedThreadIds: next,
      };
    }),
  removeThreads: (ids) =>
    set((state) => {
      const idsSet = new Set(ids);
      const threadMap = new Map(state.threadMap);
      for (const id of ids) threadMap.delete(id);
      const next = new Set(state.selectedThreadIds);
      for (const id of ids) next.delete(id);
      return {
        threads: state.threads.filter((t) => !idsSet.has(t.id)),
        threadMap,
        selectedThreadId: state.selectedThreadId && idsSet.has(state.selectedThreadId) ? null : state.selectedThreadId,
        selectedThreadIds: next,
      };
    }),
  setSearch: (query, threadIds) => set({ searchQuery: query, searchThreadIds: threadIds }),
  setSearchResults: (searchResults) =>
    set((state) => {
      if (!searchResults) return { searchResults };
      const threadMap = new Map(state.threadMap);
      for (const t of searchResults) threadMap.set(t.id, t);
      return { searchResults, threadMap };
    }),
  setSearchLoading: (searchLoading) => set({ searchLoading }),
  clearSearch: () => set({ searchQuery: "", searchThreadIds: null, searchResults: null, searchLoading: false }),
  mergeSemanticResults: (results) =>
    set((state) => {
      if (state.searchResults === null) return {};
      return {
        searchResults: results,
        searchThreadIds: new Set(results.map((t) => t.id)),
      };
    }),
  addThreads: (newThreads) =>
    set((state) => {
      const existingIds = new Set(state.threads.map((t) => t.id));
      const filteredNew = newThreads.filter((t) => !existingIds.has(t.id));

      const threads = [...filteredNew, ...state.threads];
      const threadMap = new Map(state.threadMap);
      for (const t of filteredNew) threadMap.set(t.id, t);

      let searchThreadIds = state.searchThreadIds;
      if (searchThreadIds) {
        searchThreadIds = new Set(searchThreadIds);
        for (const t of newThreads) searchThreadIds.add(t.id);
      }

      return { threads, threadMap, searchThreadIds };
    }),
}));
