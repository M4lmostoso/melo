import { useState, useRef, useCallback } from "react";
import { searchMessages } from "@/services/db/search";
import {
  getThreadsByIdsBatch,
  getThreadLabelsByIdsBatch,
} from "@/services/db/threads";
import { useAccountStore } from "@/stores/accountStore";
import { useThreadStore, type Thread } from "@/stores/threadStore";
import { useSmartFolderStore } from "@/stores/smartFolderStore";
import { useComposerStore } from "@/stores/composerStore";
import { InputDialog } from "@/components/ui/InputDialog";
import { Search, X, FolderPlus, Pencil } from "lucide-react";

const SEARCH_HIT_LIMIT = 100;

export function SearchBar() {
  const searchQuery = useThreadStore((s) => s.searchQuery);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const accounts = useAccountStore((s) => s.accounts);
  const openComposer = useComposerStore((s) => s.openComposer);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [showSaveModal, setShowSaveModal] = useState(false);

  const resizeTextarea = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  const handleSaveAsSmartFolder = useCallback(() => {
    if (useThreadStore.getState().searchQuery.trim().length < 2) return;
    setShowSaveModal(true);
  }, []);

  const handleChange = useCallback(
    (value: string) => {
      const store = useThreadStore.getState();

      if (debounceRef.current) clearTimeout(debounceRef.current);

      // Synchronously update the query (controls the textarea value).
      // Clear any previous search results so the UI doesn't display stale
      // matches while the new debounced query is in flight.
      store.setSearch(value, null);
      store.setSearchResults(null);
      store.setSearchLoading(false);

      if (value.trim().length < 2) {
        return;
      }

      // Mark "loading" only after a short delay so the spinner doesn't flash
      // on every keystroke; the debounce itself acts as the delay.
      store.setSearchLoading(true);

      debounceRef.current = setTimeout(async () => {
        const isStale = () => useThreadStore.getState().searchQuery !== value;
        try {
          const hits = await searchMessages(
            value,
            activeAccountId ?? undefined,
            SEARCH_HIT_LIMIT,
          );
          if (isStale()) return;

          if (hits.length === 0) {
            useThreadStore.getState().setSearchResults([]);
            useThreadStore.getState().setSearchLoading(false);
            useThreadStore.getState().setSearch(value, new Set());
            return;
          }

          // Deduplicate to one entry per thread (searchMessages returns one row
          // per matching message, so the same thread may appear multiple times).
          const seen = new Set<string>();
          const uniquePairs: Array<{ accountId: string; threadId: string }> = [];
          const orderByThreadId = new Map<string, number>();
          for (const h of hits) {
            if (seen.has(h.thread_id)) continue;
            seen.add(h.thread_id);
            orderByThreadId.set(h.thread_id, uniquePairs.length);
            uniquePairs.push({ accountId: h.account_id, threadId: h.thread_id });
          }

          const [dbThreads, labelsByKey] = await Promise.all([
            getThreadsByIdsBatch(uniquePairs),
            getThreadLabelsByIdsBatch(uniquePairs),
          ]);
          if (isStale()) return;

          const mapped: Thread[] = dbThreads.map((t) => ({
            id: t.id,
            accountId: t.account_id,
            subject: t.subject,
            snippet: t.snippet,
            lastMessageAt: t.last_message_at ?? 0,
            messageCount: t.message_count,
            isRead: t.is_read === 1,
            isStarred: t.is_starred === 1,
            isPinned: t.is_pinned === 1,
            isMuted: t.is_muted === 1,
            hasAttachments: t.has_attachments === 1,
            labelIds: labelsByKey.get(`${t.account_id}:${t.id}`) ?? [],
            fromName: t.from_name,
            fromAddress: t.from_address,
            allSenders: t.all_senders,
            urgencyScore: t.urgency_score ?? undefined,
            sentimentScore: t.sentiment_score ?? undefined,
            isHeatExtinguished: t.is_heat_extinguished === 1,
          }));

          // Preserve FTS5 rank ordering from `hits`
          mapped.sort((a, b) => {
            const ai = orderByThreadId.get(a.id) ?? Number.MAX_SAFE_INTEGER;
            const bi = orderByThreadId.get(b.id) ?? Number.MAX_SAFE_INTEGER;
            return ai - bi;
          });

          if (isStale()) return;
          useThreadStore.getState().setSearch(value, new Set(mapped.map((t) => t.id)));
          useThreadStore.getState().setSearchResults(mapped);
          useThreadStore.getState().setSearchLoading(false);
        } catch (err) {
          console.error("Search failed:", err);
          if (!isStale()) {
            useThreadStore.getState().setSearchResults([]);
            useThreadStore.getState().setSearchLoading(false);
          }
        }
      }, 200);
    },
    [activeAccountId],
  );

  const handleClear = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    useThreadStore.getState().clearSearch();
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    textareaRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      useThreadStore.getState().clearSearch();
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      textareaRef.current?.blur();
    } else if (e.key === "Enter" && !e.shiftKey) {
      // Prevent newline on plain Enter; search already debounced
      e.preventDefault();
    }
  };

  return (
    <div className="flex items-center gap-2">
      <div className="relative flex-1">
        <Search
          size={14}
          className="absolute left-2.5 top-[0.625rem] text-text-tertiary pointer-events-none"
        />
        <textarea
          ref={textareaRef}
          rows={1}
          value={searchQuery}
          onChange={(e) => {
            resizeTextarea(e.target);
            handleChange(e.target.value);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Search... (from: to: has:attachment)"
          className="w-full bg-bg-tertiary text-text-primary text-sm pl-8 pr-10 py-1.5 rounded-md border border-border-primary focus:border-accent focus:outline-none placeholder:text-text-tertiary resize-none leading-5 overflow-hidden"
          style={{ minHeight: "2rem", maxHeight: "6rem" }}
        />
        {searchQuery && (
          <div className="absolute right-2 top-[0.375rem] flex items-center gap-1">
            {searchQuery.trim().length >= 2 && (
              <button
                onClick={handleSaveAsSmartFolder}
                className="text-text-tertiary hover:text-accent transition-colors"
                title="Save as Smart Folder"
              >
                <FolderPlus size={14} />
              </button>
            )}
            <button
              onClick={handleClear}
              className="text-text-tertiary hover:text-text-primary transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        )}
      </div>
      <button
        onClick={() => {
          const fallbackAccountId = activeAccountId
            ?? accounts.find((a) => a.includeInGlobal)?.id
            ?? undefined;
          openComposer({ accountId: fallbackAccountId });
        }}
        className="flex items-center justify-center w-8 h-8 rounded-full bg-accent hover:bg-accent-hover text-white transition-colors shrink-0"
        title="Compose new email"
      >
        <Pencil size={14} />
      </button>
      <InputDialog
        isOpen={showSaveModal}
        onClose={() => setShowSaveModal(false)}
        onSubmit={(values) => {
          useSmartFolderStore
            .getState()
            .createFolder(
              values.name!.trim(),
              useThreadStore.getState().searchQuery.trim(),
              activeAccountId ?? undefined,
            );
        }}
        title="Save as Smart Folder"
        fields={[
          { key: "name", label: "Name", defaultValue: searchQuery.trim() },
        ]}
        submitLabel="Save"
      />
    </div>
  );
}
