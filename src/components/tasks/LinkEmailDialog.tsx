import { useState, useEffect, useRef, useCallback } from "react";
import { Search, Mail } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { t } from "@/i18n";
import { searchThreadsBySubject, type ThreadSearchResult } from "@/services/db/threads";

interface LinkEmailDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Account to scope the search to, or null for unified (all accounts). */
  accountId: string | null;
  onSelect: (threadId: string, threadAccountId: string, subject: string | null) => void;
}

function formatDate(ts: number | null): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function LinkEmailDialog({ isOpen, onClose, accountId, onSelect }: LinkEmailDialogProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ThreadSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setResults([]);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Debounced search as the user types.
  useEffect(() => {
    if (!isOpen) return;
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    setLoading(true);
    const handle = setTimeout(async () => {
      try {
        const rows = await searchThreadsBySubject(accountId, q, 30);
        setResults(rows);
      } catch (err) {
        console.error("[LinkEmailDialog] search failed:", err);
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [query, accountId, isOpen]);

  const handlePick = useCallback(
    (r: ThreadSearchResult) => {
      onSelect(r.id, r.account_id, r.subject);
      onClose();
    },
    [onSelect, onClose],
  );

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t("tasks.linkEmail.title")} width="w-[32rem]">
      <div className="p-4">
        <div className="relative mb-3">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("tasks.linkEmail.searchPlaceholder")}
            className="w-full pl-9 pr-3 py-2 bg-bg-tertiary border border-border-primary rounded-lg text-sm text-text-primary outline-none focus:border-accent"
            spellCheck={false}
          />
        </div>

        <div className="max-h-80 overflow-y-auto -mx-1 px-1">
          {loading && (
            <p className="text-xs text-text-tertiary py-4 text-center">{t("tasks.linkEmail.searching")}</p>
          )}
          {!loading && query.trim().length >= 2 && results.length === 0 && (
            <p className="text-xs text-text-tertiary py-4 text-center">{t("tasks.linkEmail.noResults")}</p>
          )}
          {!loading && query.trim().length < 2 && (
            <p className="text-xs text-text-tertiary py-4 text-center">{t("tasks.linkEmail.hint")}</p>
          )}
          <div className="space-y-0.5">
            {results.map((r) => (
              <button
                key={`${r.account_id}-${r.id}`}
                onClick={() => handlePick(r)}
                className="w-full flex items-start gap-2 px-2.5 py-2 rounded-lg text-left hover:bg-bg-hover transition-colors"
              >
                <Mail size={14} className="text-text-tertiary shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-text-primary truncate">
                    {r.subject?.trim() || t("tasks.group.noSubject")}
                  </p>
                  <p className="text-xs text-text-tertiary truncate">
                    {(r.from_name || r.from_address || "").trim()}
                    {r.last_message_at ? ` · ${formatDate(r.last_message_at)}` : ""}
                  </p>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
