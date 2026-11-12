import { useState, useCallback, useRef, useEffect } from "react";
import { Sparkles, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { t } from "@/i18n";
import { isAiAvailable, summarizeThread } from "@/services/ai/aiService";
import { isRateLimitError } from "@/services/ai/errors";
import { deleteAiCache, getAiCache } from "@/services/db/aiCache";
import { getSetting } from "@/services/db/settings";
import type { DbMessage } from "@/services/db/messages";

interface ThreadSummaryProps {
  threadId: string;
  accountId: string;
  messages: DbMessage[];
}

export function ThreadSummary({ threadId, accountId, messages }: ThreadSummaryProps) {
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [available, setAvailable] = useState(false);
  const checkedRef = useRef(false);

  useEffect(() => {
    if (checkedRef.current) return;
    checkedRef.current = true;
    if (messages.length < 2) return;
    isAiAvailable().then(setAvailable);
  }, [messages.length]);

  const loadingRef = useRef(false);
  // `auto` = fired by opening the thread, not by a click: refused without a
  // network call while the provider is rate-limiting us (see ai/rateLimiter.ts).
  const loadSummary = useCallback(async (auto: boolean) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const result = await summarizeThread(threadId, accountId, messages, auto ? "auto" : "interactive");
      setSummary(result);
    } catch (err) {
      // A refused automatic call is expected, not a failure — the button stays.
      if (!(auto && isRateLimitError(err))) console.error("Failed to summarize thread:", err);
      setSummary(null);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [threadId, accountId, messages]);

  // On open: show what is cached; generate only when "Auto-summarize threads"
  // is on (`ai_auto_summarize` — the toggle existed but nothing read it).
  // Tried once per thread: this effect re-runs whenever `messages` changes
  // identity, and a failing provider used to be re-asked every time.
  const autoTriedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!available || messages.length < 2 || summary !== null || loadingRef.current) return;
    if (autoTriedRef.current === threadId) return;
    autoTriedRef.current = threadId;
    // Staleness is judged by thread, not by an effect-cleanup flag: a cleanup
    // on a mere `messages` change would cancel the one attempt we allow.
    const stale = () => autoTriedRef.current !== threadId;
    (async () => {
      const cached = await getAiCache(accountId, threadId, "summary").catch(() => null);
      if (stale()) return;
      if (cached) {
        setSummary(cached);
        return;
      }
      const autoOn = (await getSetting("ai_auto_summarize").catch(() => null)) !== "false";
      if (!stale() && autoOn) loadSummary(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per thread, see above
  }, [available, messages.length, summary, threadId, accountId]);

  const handleRefresh = useCallback(async () => {
    await deleteAiCache(accountId, threadId, "summary");
    setSummary(null);
    setLoading(true);
    try {
      const result = await summarizeThread(threadId, accountId, messages);
      setSummary(result);
    } catch (err) {
      console.error("Failed to refresh summary:", err);
    } finally {
      setLoading(false);
    }
  }, [threadId, accountId, messages]);

  if (!available || messages.length < 2) return null;

  return (
    <div className="mx-4 my-2 p-3 rounded-lg bg-accent/5 border border-accent/20">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center gap-2 w-full text-left"
      >
        <Sparkles size={14} className="text-accent shrink-0" />
        <span className="text-xs font-medium text-accent flex-1">{t("email.threadSummary.aiSummary")}</span>
        {summary && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); handleRefresh(); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); handleRefresh(); } }}
            className="p-0.5 text-text-tertiary hover:text-accent transition-colors cursor-pointer"
            title={t("email.threadSummary.refreshSummary")}
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          </span>
        )}
        {collapsed ? <ChevronDown size={14} className="text-text-tertiary" /> : <ChevronUp size={14} className="text-text-tertiary" />}
      </button>
      {!collapsed && (
        <div className="mt-2 text-sm text-text-secondary">
          {loading && !summary && (
            <div className="flex items-center gap-2 text-text-tertiary">
              <div className="w-3 h-3 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
              <span className="text-xs">{t("email.threadSummary.generating")}</span>
            </div>
          )}
          {!loading && !summary && (
            <button
              onClick={() => loadSummary(false)}
              className="px-3 py-1 text-xs text-accent bg-bg-primary border border-accent/30 rounded-full hover:bg-bg-hover transition-colors"
            >
              {t("ai.threadSummary.summarize")}
            </button>
          )}
          {summary && <p className="text-xs leading-relaxed">{summary}</p>}
        </div>
      )}
    </div>
  );
}
