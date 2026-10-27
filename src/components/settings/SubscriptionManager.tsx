import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { t } from "@/i18n";
import { useAccountStore } from "@/stores/accountStore";
import { useToastStore } from "@/stores/toastStore";
import {
  getSubscriptions,
  executeUnsubscribe,
  cleanupSenderMail,
  isUnsubscribeSuggested,
  parseUnsubscribeHeaders,
  type SenderCleanup,
  type SubscriptionEntry,
} from "@/services/unsubscribe/unsubscribeManager";
import {
  MailMinus,
  Search,
  Loader2,
  ChevronDown,
  ExternalLink,
  Archive,
  Trash2,
} from "lucide-react";
import { formatRelativeDate } from "@/utils/date";
import { getSetting, setSetting } from "@/services/db/settings";
import { ToggleRow } from "@/components/settings/tabs/shared";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

type SortMode = "recent" | "volume" | "ignored";
type FilterMode = "all" | "suggested" | "unsubscribed";
/** `undefined` = plain Unsubscribe, the auto-archive setting decides. */
type UnsubscribeCleanup = SenderCleanup | "none" | undefined;

type MenuAction =
  | { kind: "unsubscribe"; cleanup: UnsubscribeCleanup }
  | { kind: "cleanup"; cleanup: SenderCleanup };

/** Pending confirmation for anything that moves mail to the Trash. */
interface TrashConfirm {
  senders: SubscriptionEntry[];
  action: MenuAction;
}

const senderLabel = (s: SubscriptionEntry) => s.from_name ?? s.from_address;

function senderHue(address: string): number {
  let h = 0;
  for (let i = 0; i < address.length; i++) h = (h * 31 + address.charCodeAt(i)) % 360;
  return h;
}

function openRate(s: SubscriptionEntry): number {
  return s.message_count > 0 ? s.read_count / s.message_count : 0;
}

function ActionMenu({
  items,
  onSelect,
  disabled,
}: {
  items: { action: MenuAction; label: string; danger?: boolean }[];
  onSelect: (action: MenuAction) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-label={t("settings.subscriptionManager.moreActions")}
        title={t("settings.subscriptionManager.moreActions")}
        className="flex items-center px-1.5 py-1 text-xs text-text-secondary hover:text-text-primary bg-bg-tertiary rounded-md border border-border-primary transition-colors disabled:opacity-50"
      >
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="glass-panel absolute right-0 top-full mt-1 z-20 min-w-[13rem] rounded-lg border border-border-primary py-1 shadow-lg">
          {items.map((item) => (
            <button
              key={item.label}
              onClick={() => {
                setOpen(false);
                onSelect(item.action);
              }}
              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-bg-hover transition-colors ${
                item.danger ? "text-danger" : "text-text-primary"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const UNSUBSCRIBE_MENU: { action: MenuAction; label: string; danger?: boolean }[] = [
  { action: { kind: "unsubscribe", cleanup: "none" }, label: "settings.subscriptionManager.unsubscribeOnly" },
  { action: { kind: "unsubscribe", cleanup: "archive" }, label: "settings.subscriptionManager.unsubscribeArchive" },
  { action: { kind: "unsubscribe", cleanup: "trash" }, label: "settings.subscriptionManager.unsubscribeTrash", danger: true },
];

const translateMenu = (items: typeof UNSUBSCRIBE_MENU) =>
  items.map((i) => ({ ...i, label: t(i.label) }));

export function SubscriptionManager() {
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const accounts = useAccountStore((s) => s.accounts);
  const showToast = useToastStore((s) => s.showToast);
  const [accountId, setAccountId] = useState<string | null>(activeAccountId);
  const [subscriptions, setSubscriptions] = useState<SubscriptionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("recent");
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [autoArchive, setAutoArchive] = useState(true);
  const [trashConfirm, setTrashConfirm] = useState<TrashConfirm | null>(null);

  useEffect(() => {
    if (!accountId && activeAccountId) setAccountId(activeAccountId);
  }, [accountId, activeAccountId]);

  useEffect(() => {
    getSetting("auto_archive_after_unsubscribe")
      .then((raw) => setAutoArchive(raw !== "false"))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!accountId) return;
    setLoading(true);
    setSelectedIds(new Set());
    getSubscriptions(accountId)
      .then((subs) => setSubscriptions(subs))
      .catch((err) => console.error("Failed to load subscriptions:", err))
      .finally(() => setLoading(false));
  }, [accountId]);

  const setBusy = (addr: string, busy: boolean) =>
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(addr);
      else next.delete(addr);
      return next;
    });

  const runAction = useCallback(async (sub: SubscriptionEntry, action: MenuAction) => {
    if (!accountId) return;
    const sender = senderLabel(sub);
    setBusy(sub.from_address, true);
    try {
      if (action.kind === "cleanup") {
        const count = await cleanupSenderMail(accountId, sub.from_address, action.cleanup);
        showToast(
          "info",
          t(
            action.cleanup === "trash"
              ? "settings.subscriptionManager.toastCleanedTrashed"
              : "settings.subscriptionManager.toastCleanedArchived",
            { count, sender },
          ),
        );
        return;
      }

      const result = await executeUnsubscribe(
        accountId,
        "", // threadId not critical for tracking
        sub.from_address,
        sub.from_name,
        sub.latest_unsubscribe_header,
        sub.latest_unsubscribe_post,
        action.cleanup,
      );
      if (!result.success) {
        showToast("error", t("settings.subscriptionManager.toastFailed", { sender }));
        return;
      }
      setSubscriptions((prev) =>
        prev.map((s) =>
          s.from_address === sub.from_address ? { ...s, status: "unsubscribed" } : s,
        ),
      );
      const opened = result.method === "browser" || result.method === "browser_body";
      let message = opened
        ? t("settings.subscriptionManager.toastBrowser", { sender })
        : t("settings.subscriptionManager.toastDone", { sender });
      if (result.cleaned > 0) {
        message += " " + t(
          action.cleanup === "trash"
            ? "settings.subscriptionManager.toastCleanedTrashed"
            : "settings.subscriptionManager.toastCleanedArchived",
          { count: result.cleaned, sender },
        );
      }
      showToast("info", message);
    } catch (err) {
      console.error("Failed to unsubscribe:", err);
      showToast("error", t("settings.subscriptionManager.toastFailed", { sender }));
    } finally {
      setBusy(sub.from_address, false);
    }
  }, [accountId, showToast]);

  const runOnSenders = useCallback(async (senders: SubscriptionEntry[], action: MenuAction) => {
    for (const sub of senders) {
      await runAction(sub, action);
    }
  }, [runAction]);

  const requestAction = (senders: SubscriptionEntry[], action: MenuAction) => {
    if (action.cleanup === "trash") {
      setTrashConfirm({ senders, action });
      return;
    }
    void runOnSenders(senders, action);
  };

  const selectedSenders = useMemo(
    () => subscriptions.filter((s) => selectedIds.has(s.from_address) && s.status !== "unsubscribed"),
    [subscriptions, selectedIds],
  );

  const runBulk = (action: MenuAction) => {
    const senders = selectedSenders;
    setSelectedIds(new Set());
    requestAction(senders, action);
  };

  const toggleSelect = (addr: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(addr)) next.delete(addr);
      else next.add(addr);
      return next;
    });
  };

  const suggestedCount = useMemo(
    () => subscriptions.filter(isUnsubscribeSuggested).length,
    [subscriptions],
  );

  const visible = useMemo(() => {
    const q = searchQuery.toLowerCase();
    const list = subscriptions.filter((s) => {
      if (filterMode === "suggested" && !isUnsubscribeSuggested(s)) return false;
      if (filterMode === "unsubscribed" && s.status !== "unsubscribed") return false;
      if (!q) return true;
      return s.from_address.includes(q) || (s.from_name?.toLowerCase().includes(q) ?? false);
    });
    if (sortMode === "volume") {
      return [...list].sort((a, b) => b.count_30d - a.count_30d || b.message_count - a.message_count);
    }
    if (sortMode === "ignored") {
      return [...list].sort((a, b) => openRate(a) - openRate(b) || b.message_count - a.message_count);
    }
    return list; // already newest-first from SQL
  }, [subscriptions, searchQuery, filterMode, sortMode]);

  if (!accountId) {
    return <p className="text-sm text-text-tertiary">{t("settings.subscriptionManager.noActiveAccount")}</p>;
  }

  const filterChip = (mode: FilterMode, label: string) => (
    <button
      onClick={() => setFilterMode(mode)}
      className={`px-2.5 py-1 text-xs rounded-full transition-colors ${
        filterMode === mode
          ? "bg-accent/15 text-accent"
          : "text-text-secondary hover:bg-bg-hover"
      }`}
    >
      {label}
    </button>
  );

  const confirmSender = trashConfirm?.senders.length === 1 ? senderLabel(trashConfirm.senders[0]!) : null;

  return (
    <div className="space-y-4">
      <ToggleRow
        label={t("settings.subscriptionManager.autoArchive")}
        description={t("settings.subscriptionManager.autoArchiveDesc")}
        checked={autoArchive}
        onToggle={async () => {
          const next = !autoArchive;
          setAutoArchive(next);
          await setSetting("auto_archive_after_unsubscribe", String(next));
        }}
      />

      <div className="flex flex-wrap items-center gap-2">
        {accounts.length > 1 && (
          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            aria-label={t("settings.subscriptionManager.account")}
            className="max-w-[14rem] px-2 py-1.5 bg-bg-tertiary border border-border-primary rounded-md text-xs text-text-primary outline-none focus:border-accent"
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label ?? a.displayName ?? a.email}
              </option>
            ))}
          </select>
        )}
        <div className="relative flex-1 min-w-[10rem]">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("settings.subscriptionManager.searchPlaceholder")}
            className="w-full pl-8 pr-3 py-1.5 bg-bg-tertiary border border-border-primary rounded-md text-xs text-text-primary outline-none focus:border-accent"
            spellCheck={false}
          />
        </div>
        <select
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value as SortMode)}
          aria-label={t("settings.subscriptionManager.sortLabel")}
          className="px-2 py-1.5 bg-bg-tertiary border border-border-primary rounded-md text-xs text-text-primary outline-none focus:border-accent"
        >
          <option value="recent">{t("settings.subscriptionManager.sortRecent")}</option>
          <option value="volume">{t("settings.subscriptionManager.sortVolume")}</option>
          <option value="ignored">{t("settings.subscriptionManager.sortIgnored")}</option>
        </select>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {filterChip("all", t("settings.subscriptionManager.filterAll"))}
          {filterChip("suggested", t("settings.subscriptionManager.filterSuggested", { count: suggestedCount }))}
          {filterChip("unsubscribed", t("settings.subscriptionManager.filterUnsubscribed"))}
        </div>
        {selectedSenders.length > 0 && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => runBulk({ kind: "unsubscribe", cleanup: undefined })}
              className="px-3 py-1.5 text-xs bg-danger text-white rounded-md hover:bg-danger/80 transition-colors shrink-0"
            >
              {t("settings.subscriptionManager.unsubscribeBulk", { count: selectedSenders.length })}
            </button>
            <ActionMenu items={translateMenu(UNSUBSCRIBE_MENU)} onSelect={runBulk} />
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-8 justify-center text-text-tertiary">
          <Loader2 size={16} className="animate-spin" />
          <span className="text-sm">{t("settings.subscriptionManager.loading")}</span>
        </div>
      ) : (
        <>
          <p className="text-xs text-text-tertiary">
            {t("settings.subscriptionManager.sendersDetected", { count: subscriptions.length })}
          </p>

          <div className="space-y-1 max-h-[500px] overflow-y-auto">
            {visible.map((sub) => {
              const parsed = sub.latest_unsubscribe_header
                ? parseUnsubscribeHeaders(sub.latest_unsubscribe_header, sub.latest_unsubscribe_post)
                : null;
              const isUnsubscribed = sub.status === "unsubscribed";
              const isBusy = busyIds.has(sub.from_address);
              const isSelected = selectedIds.has(sub.from_address);
              const suggested = isUnsubscribeSuggested(sub);
              const percent = Math.round(openRate(sub) * 100);

              return (
                <div
                  key={sub.from_address}
                  className={`flex items-center gap-3 py-2.5 px-3 rounded-lg transition-colors ${
                    isSelected ? "bg-accent/10" : "bg-bg-secondary hover:bg-bg-hover"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelect(sub.from_address)}
                    disabled={isUnsubscribed}
                    aria-label={senderLabel(sub)}
                    className="shrink-0 accent-accent"
                  />
                  <div
                    aria-hidden
                    className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-sm font-medium text-white"
                    style={{ backgroundColor: `hsl(${senderHue(sub.from_address)} 45% 50%)` }}
                  >
                    {senderLabel(sub).trim().charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-text-primary truncate font-medium">
                        {senderLabel(sub)}
                      </span>
                      {isUnsubscribed && (
                        <span className="text-[0.625rem] px-1.5 rounded-full bg-success/15 text-success shrink-0">
                          {t("settings.subscriptionManager.unsubscribed")}
                        </span>
                      )}
                      {!isUnsubscribed && parsed?.hasOneClick && (
                        <span className="text-[0.625rem] px-1.5 rounded-full bg-accent/15 text-accent shrink-0">
                          {t("settings.subscriptionManager.oneClick")}
                        </span>
                      )}
                      {!isUnsubscribed && !parsed && (
                        <span
                          className="text-[0.625rem] px-1.5 rounded-full bg-bg-tertiary text-text-secondary shrink-0"
                          title={t("settings.subscriptionManager.bodyLinkTitle")}
                        >
                          {t("settings.subscriptionManager.bodyLink")}
                        </span>
                      )}
                      {suggested && (
                        <span
                          className="text-[0.625rem] px-1.5 rounded-full bg-warning/15 text-warning shrink-0"
                          title={t("settings.subscriptionManager.suggestedTitle", { count: sub.message_count })}
                        >
                          {t("settings.subscriptionManager.suggested")}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-text-tertiary mt-0.5 min-w-0">
                      <span className="truncate">{sub.from_address}</span>
                      <span className="shrink-0" title={t("settings.subscriptionManager.volumeTitle", { d90: sub.count_90d, total: sub.message_count })}>
                        {t("settings.subscriptionManager.last30d", { count: sub.count_30d })}
                      </span>
                      <span className="shrink-0">
                        {t("settings.subscriptionManager.openRate", { percent })}
                      </span>
                      <span className="shrink-0">{formatRelativeDate(sub.latest_date)}</span>
                    </div>
                  </div>
                  {isUnsubscribed ? (
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => requestAction([sub], { kind: "cleanup", cleanup: "archive" })}
                        disabled={isBusy}
                        title={t("settings.subscriptionManager.archiveMail")}
                        aria-label={t("settings.subscriptionManager.archiveMail")}
                        className="p-1.5 text-text-secondary hover:text-text-primary bg-bg-tertiary rounded-md border border-border-primary transition-colors disabled:opacity-50"
                      >
                        {isBusy ? <Loader2 size={12} className="animate-spin" /> : <Archive size={12} />}
                      </button>
                      <button
                        onClick={() => requestAction([sub], { kind: "cleanup", cleanup: "trash" })}
                        disabled={isBusy}
                        title={t("settings.subscriptionManager.trashMail")}
                        aria-label={t("settings.subscriptionManager.trashMail")}
                        className="p-1.5 text-danger hover:text-danger/80 bg-bg-tertiary rounded-md border border-border-primary transition-colors disabled:opacity-50"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => requestAction([sub], { kind: "unsubscribe", cleanup: undefined })}
                        disabled={isBusy}
                        title={parsed ? undefined : t("settings.subscriptionManager.bodyLinkTitle")}
                        className="flex items-center gap-1 px-2.5 py-1 text-xs text-danger hover:text-danger/80 bg-bg-tertiary rounded-md border border-border-primary transition-colors disabled:opacity-50"
                      >
                        {isBusy ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : parsed ? (
                          <MailMinus size={12} />
                        ) : (
                          <ExternalLink size={12} />
                        )}
                        {isBusy
                          ? "..."
                          : parsed
                            ? t("settings.subscriptionManager.unsubscribe")
                            : t("settings.subscriptionManager.openOptOut")}
                      </button>
                      <ActionMenu
                        items={translateMenu(UNSUBSCRIBE_MENU)}
                        onSelect={(action) => requestAction([sub], action)}
                        disabled={isBusy}
                      />
                    </div>
                  )}
                </div>
              );
            })}
            {visible.length === 0 && (
              <p className="text-sm text-text-tertiary py-4 text-center">
                {searchQuery || filterMode !== "all"
                  ? t("settings.subscriptionManager.noMatchingSenders")
                  : t("settings.subscriptionManager.noSubscriptions")}
              </p>
            )}
          </div>
        </>
      )}

      <ConfirmDialog
        isOpen={trashConfirm !== null}
        onClose={() => setTrashConfirm(null)}
        onConfirm={() => {
          if (trashConfirm) void runOnSenders(trashConfirm.senders, trashConfirm.action);
          setTrashConfirm(null);
        }}
        title={t("settings.subscriptionManager.confirmTrashTitle")}
        message={
          confirmSender
            ? t("settings.subscriptionManager.confirmTrashMessage", { sender: confirmSender })
            : t("settings.subscriptionManager.confirmTrashMessageBulk", { count: trashConfirm?.senders.length ?? 0 })
        }
        confirmLabel={t("settings.subscriptionManager.confirmTrashButton")}
        variant="danger"
      />
    </div>
  );
}
