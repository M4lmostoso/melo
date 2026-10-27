import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { Paperclip, Search, LayoutGrid, List } from "lucide-react";
import { t } from "@/i18n";
import { useAccountStore } from "@/stores/accountStore";
import {
  searchAttachments,
  countAttachments,
  ATTACHMENT_PAGE_SIZE,
  getAttachmentSenders,
  getAttachmentSendersForAccounts,
  type AttachmentWithContext,
  type AttachmentSender,
  type AttachmentFilters,
  type AttachmentTypeFilter as TypeFilter,
  type AttachmentDateFilter as DateFilter,
  type AttachmentSizeFilter as SizeFilter,
} from "@/services/db/attachments";
import { getEmailProvider } from "@/services/email/providerFactory";
import { AttachmentPreview } from "@/components/email/AttachmentList";
import { AttachmentGridItem } from "./AttachmentGridItem";
import { AttachmentListItem } from "./AttachmentListItem";
import { EmptyState } from "@/components/ui/EmptyState";
import { navigateToLabel } from "@/router/navigate";
import { useMultiSelect } from "@/hooks/useMultiSelect";
import { useDragOut } from "@/hooks/useDragOut";
import { toAttachmentRef, openAttachmentWithDefaultApp } from "@/services/attachments/attachmentActions";
import { openAttachmentPreviewWindow } from "@/services/attachments/previewWindow";

type ViewMode = "grid" | "list";

const TYPE_OPTIONS: { value: TypeFilter; label: () => string }[] = [
  { value: "all", label: () => t("attachments.library.filterAllTypes") },
  { value: "images", label: () => t("attachments.library.filterImages") },
  { value: "pdfs", label: () => t("attachments.library.filterPdfs") },
  { value: "documents", label: () => t("attachments.library.filterDocuments") },
  { value: "spreadsheets", label: () => t("attachments.library.filterSpreadsheets") },
  { value: "archives", label: () => t("attachments.library.filterArchives") },
  { value: "other", label: () => t("attachments.library.filterOther") },
];

const DATE_OPTIONS: { value: DateFilter; label: () => string }[] = [
  { value: "all", label: () => t("attachments.library.dateAnyTime") },
  { value: "today", label: () => t("attachments.library.dateToday") },
  { value: "week", label: () => t("attachments.library.datePastWeek") },
  { value: "month", label: () => t("attachments.library.datePastMonth") },
  { value: "year", label: () => t("attachments.library.datePastYear") },
];

const SIZE_OPTIONS: { value: SizeFilter; label: () => string }[] = [
  { value: "all", label: () => t("attachments.library.sizeAny") },
  { value: "small", label: () => t("attachments.library.sizeSmall") },
  { value: "medium", label: () => t("attachments.library.sizeMedium") },
  { value: "large", label: () => t("attachments.library.sizeLarge") },
];

/** Keystroke debounce before the free-text search hits the DB. */
const SEARCH_DEBOUNCE_MS = 200;

export function AttachmentLibrary() {
  const accounts = useAccountStore((s) => s.accounts);
  // null = unified view (all accounts included in global), mirrors EmailList / TasksPage.
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const isUnified = activeAccountId === null;

  // Accounts whose attachments are shown: the single active one, or every global account.
  const visibleAccountIds = useMemo(
    () =>
      activeAccountId
        ? [activeAccountId]
        : accounts.filter((a) => a.includeInGlobal).map((a) => a.id),
    [activeAccountId, accounts],
  );
  const accountIdsKey = visibleAccountIds.join(",");

  // Lookup for rendering per-account badges in unified view.
  const accountMeta = useMemo(() => {
    const map = new Map<string, { label: string; color: string | null }>();
    for (const a of accounts) {
      map.set(a.id, { label: a.label || a.displayName || a.email, color: a.color });
    }
    return map;
  }, [accounts]);

  const [attachments, setAttachments] = useState<AttachmentWithContext[]>([]);
  const [senders, setSenders] = useState<AttachmentSender[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [senderFilter, setSenderFilter] = useState("all");
  const [accountFilter, setAccountFilter] = useState("all");
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");
  const [sizeFilter, setSizeFilter] = useState<SizeFilter>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [previewAttachment, setPreviewAttachment] = useState<AttachmentWithContext | null>(null);
  // progress: 0-100 while downloading, -1 on error; absent when idle
  const [downloadProgress, setDownloadProgress] = useState<Map<string, number>>(new Map());
  const [downloadErrors, setDownloadErrors] = useState<Map<string, string>>(new Map());

  // Listen to Rust progress events
  useEffect(() => {
    type ProgressPayload = { attachmentId: string; downloaded: number; total: number };
    const unlisten = listen<ProgressPayload>("attachment-download-progress", (e) => {
      const { attachmentId, downloaded, total } = e.payload;
      const pct = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
      setDownloadProgress((prev) => new Map(prev).set(attachmentId, pct));
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(searchQuery), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [searchQuery]);

  // Every filter runs in SQL, so search reaches the whole archive; the page
  // size only caps how many matches are rendered at once.
  const filters = useMemo<AttachmentFilters>(
    () => ({
      query: debouncedQuery,
      type: typeFilter,
      sender: senderFilter === "all" ? null : senderFilter,
      date: dateFilter,
      size: sizeFilter,
    }),
    [debouncedQuery, typeFilter, senderFilter, dateFilter, sizeFilter],
  );
  const hasActiveFilters =
    debouncedQuery.trim() !== "" || typeFilter !== "all" || senderFilter !== "all" ||
    accountFilter !== "all" || dateFilter !== "all" || sizeFilter !== "all";

  // Keyed on the id string, not the array: a fresh `accounts` array from the
  // store must not re-run the first-page load and throw away loaded pages.
  const queryAccountIds = useMemo(
    () => {
      const ids = accountIdsKey ? accountIdsKey.split(",") : [];
      return accountFilter === "all" ? ids : ids.filter((id) => id === accountFilter);
    },
    [accountIdsKey, accountFilter],
  );

  // Monotonic request id: a slow response for an old filter set must not
  // overwrite the results of the one the user is looking at now.
  const requestRef = useRef(0);
  const loadedCountRef = useRef(0);
  loadedCountRef.current = attachments.length;

  const loadFirstPage = useCallback(
    async (acctIds: string[], f: AttachmentFilters, limit: number, showSpinner: boolean) => {
      const requestId = ++requestRef.current;
      if (showSpinner) setLoading(true);
      try {
        const [atts, total] = await Promise.all([
          searchAttachments(acctIds, f, limit, 0),
          countAttachments(acctIds, f),
        ]);
        if (requestId !== requestRef.current) return;
        setAttachments(atts);
        setTotalCount(total);
      } catch (err) {
        console.error("Failed to load attachments:", err);
      } finally {
        if (requestId === requestRef.current) setLoading(false);
      }
    },
    [],
  );

  const loadSenders = useCallback(async (acctIds: string[]) => {
    try {
      const single = acctIds.length === 1 ? acctIds[0] : null;
      setSenders(await (single ? getAttachmentSenders(single) : getAttachmentSendersForAccounts(acctIds)));
    } catch (err) {
      console.error("Failed to load attachment senders:", err);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingMore) return;
    const requestId = requestRef.current;
    setLoadingMore(true);
    try {
      const more = await searchAttachments(queryAccountIds, filters, ATTACHMENT_PAGE_SIZE, attachments.length);
      if (requestId !== requestRef.current) return;
      setAttachments((prev) => [...prev, ...more]);
    } catch (err) {
      console.error("Failed to load more attachments:", err);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, queryAccountIds, filters, attachments.length]);

  // Reset the account subdivision filter when leaving unified view.
  useEffect(() => {
    if (!isUnified) setAccountFilter("all");
  }, [isUnified]);

  // Load senders on account change
  useEffect(() => {
    if (visibleAccountIds.length > 0) loadSenders(visibleAccountIds);
    else setSenders([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountIdsKey, loadSenders]);

  // (Re)load the first page whenever the account scope or a filter changes
  useEffect(() => {
    if (queryAccountIds.length > 0) {
      // Spinner only on a cold load: refining a search keeps the old results
      // on screen until the new ones arrive instead of flashing "Loading".
      loadFirstPage(queryAccountIds, filters, ATTACHMENT_PAGE_SIZE, loadedCountRef.current === 0);
    } else {
      requestRef.current++;
      setAttachments([]);
      setTotalCount(0);
      setLoading(false);
    }
  }, [queryAccountIds, filters, loadFirstPage]);

  // Refresh on sync, keeping as many rows as are already on screen
  useEffect(() => {
    const handler = () => {
      if (queryAccountIds.length === 0) return;
      loadFirstPage(queryAccountIds, filters, Math.max(ATTACHMENT_PAGE_SIZE, loadedCountRef.current), false);
      loadSenders(visibleAccountIds);
    };
    window.addEventListener("melo-sync-done", handler);
    return () => window.removeEventListener("melo-sync-done", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryAccountIds, filters, loadFirstPage, loadSenders]);

  const hasMore = attachments.length < totalCount;

  const sel = useMultiSelect(attachments.map((a) => a.id));

  // Drag set: the whole selection if the pressed item is part of it, else itself.
  const drag = useDragOut((id) => {
    if (sel.isSelected(id)) {
      return attachments.filter((a) => sel.selectedIds.has(a.id)).map(toAttachmentRef);
    }
    const att = attachments.find((a) => a.id === id);
    return att ? [toAttachmentRef(att)] : [];
  });

  const handleOpenWithApp = useCallback((att: AttachmentWithContext) => {
    openAttachmentWithDefaultApp(toAttachmentRef(att)).catch((err) => console.error("Open attachment failed:", err));
  }, []);

  const handleDownload = useCallback(async (att: AttachmentWithContext) => {
    const attachmentId = att.gmail_attachment_id ?? att.imap_part_id;
    if (!attachmentId) return;
    if (downloadProgress.has(att.id)) return; // already in progress

    const filePath = await save({ defaultPath: att.filename ?? "attachment" });
    if (!filePath) return;

    setDownloadErrors((prev) => { const m = new Map(prev); m.delete(att.id); return m; });
    setDownloadProgress((prev) => new Map(prev).set(att.id, 0));
    try {
      const provider = await getEmailProvider(att.account_id);
      await provider.downloadAttachmentToPath(
        att.message_id, attachmentId, filePath, att.id, att.size ?? 0,
      );
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(filePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[attachment] download failed:`, msg);
      setDownloadErrors((prev) => new Map(prev).set(att.id, msg));
    } finally {
      // keep progress at 100 briefly so user sees completion, then clear
      setTimeout(() => {
        setDownloadProgress((prev) => { const m = new Map(prev); m.delete(att.id); return m; });
      }, 1500);
    }
  }, [downloadProgress]);

  const handleJumpToEmail = useCallback((att: AttachmentWithContext) => {
    if (att.thread_id) {
      navigateToLabel("all", { threadId: att.thread_id });
    }
  }, []);

  // Track search input ref to avoid autofocus stealing
  const searchRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b border-border-primary">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Paperclip size={18} className="text-text-secondary" />
            <h1 className="text-base font-semibold text-text-primary">{t("attachments.library.title")}</h1>
            <span className="text-xs text-text-tertiary">({totalCount})</span>
          </div>

          <div className="flex-1" />

          {/* Search */}
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary" />
            <input
              ref={searchRef}
              type="text"
              placeholder={t("attachments.library.searchPlaceholder")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-8 pr-3 py-1.5 text-xs rounded-md border border-border-primary bg-bg-secondary text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent w-48"
              spellCheck={false}
            />
          </div>

          {/* Filters */}
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as TypeFilter)}
            className="text-xs rounded-md border border-border-primary bg-bg-secondary text-text-primary px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-accent"
          >
            {TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label()}</option>
            ))}
          </select>

          <select
            value={senderFilter}
            onChange={(e) => setSenderFilter(e.target.value)}
            className="text-xs rounded-md border border-border-primary bg-bg-secondary text-text-primary px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-accent max-w-40"
          >
            <option value="all">{t("attachments.library.senderFilterAll")}</option>
            {senders.map((s) => (
              <option key={s.from_address} value={s.from_address}>
                {s.from_name || s.from_address} ({s.count})
              </option>
            ))}
          </select>

          {/* Account subdivision — only meaningful in unified view */}
          {isUnified && visibleAccountIds.length > 1 && (
            <select
              value={accountFilter}
              onChange={(e) => setAccountFilter(e.target.value)}
              className="text-xs rounded-md border border-border-primary bg-bg-secondary text-text-primary px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-accent max-w-40"
            >
              <option value="all">{t("attachments.library.accountFilterAll")}</option>
              {visibleAccountIds.map((id) => (
                <option key={id} value={id}>
                  {accountMeta.get(id)?.label ?? id}
                </option>
              ))}
            </select>
          )}

          <select
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value as DateFilter)}
            className="text-xs rounded-md border border-border-primary bg-bg-secondary text-text-primary px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-accent"
          >
            {DATE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label()}</option>
            ))}
          </select>

          <select
            value={sizeFilter}
            onChange={(e) => setSizeFilter(e.target.value as SizeFilter)}
            className="text-xs rounded-md border border-border-primary bg-bg-secondary text-text-primary px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-accent"
          >
            {SIZE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label()}</option>
            ))}
          </select>

          {/* View toggle */}
          <div className="flex border border-border-primary rounded-md overflow-hidden">
            <button
              onClick={() => setViewMode("grid")}
              className={`p-1.5 ${viewMode === "grid" ? "bg-accent/10 text-accent" : "text-text-tertiary hover:text-text-primary"}`}
              title={t("attachments.library.gridView")}
            >
              <LayoutGrid size={14} />
            </button>
            <button
              onClick={() => setViewMode("list")}
              className={`p-1.5 ${viewMode === "list" ? "bg-accent/10 text-accent" : "text-text-tertiary hover:text-text-primary"}`}
              title={t("attachments.library.listView")}
            >
              <List size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* Download error banner — exact reason, no per-row height growth */}
      {downloadErrors.size > 0 && (
        <div className="shrink-0 px-4 py-2 bg-red-500/10 border-b border-red-500/20 flex items-start justify-between gap-2">
          <div className="flex flex-col gap-0.5 min-w-0">
            {[...downloadErrors.entries()].map(([id, msg]) => {
              const att = attachments.find((a) => a.id === id);
              return (
                <span key={id} className="text-xs text-red-500 truncate" title={msg}>
                  {att?.filename ? `${att.filename}: ` : ""}{msg}
                </span>
              );
            })}
          </div>
          <button
            onClick={() => setDownloadErrors(new Map())}
            className="text-red-400 hover:text-red-500 text-base leading-none shrink-0"
            title={t("common.close")}
          >
            ×
          </button>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-text-tertiary">{t("attachments.library.loading")}</p>
          </div>
        ) : attachments.length === 0 ? (
          <EmptyState
            icon={Paperclip}
            title={hasActiveFilters ? t("attachments.library.noMatchingAttachments") : t("attachments.library.noAttachments")}
            subtitle={hasActiveFilters ? t("attachments.library.noMatchingAttachmentsHint") : t("attachments.library.noAttachmentsHint")}
          />
        ) : viewMode === "grid" ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
            {attachments.map((att) => (
              <AttachmentGridItem
                key={att.id}
                attachment={att}
                accountLabel={isUnified ? accountMeta.get(att.account_id)?.label : undefined}
                accountColor={isUnified ? accountMeta.get(att.account_id)?.color ?? undefined : undefined}
                downloadProgress={downloadProgress.get(att.id)}
                downloadError={downloadErrors.get(att.id)}
                selected={sel.isSelected(att.id)}
                onSelect={(e) => { if (drag.didDrag()) return; sel.onItemClick(att.id, e); }}
                onOpenWithApp={() => handleOpenWithApp(att)}
                onItemMouseDown={(e) => drag.onItemMouseDown(att.id, e)}
                onItemDragStart={(e) => drag.onItemDragStart(att.id, e)}
                onItemPointerEnter={() => drag.onItemPointerEnter(att.id)}
                onPreview={() => { if (!openAttachmentPreviewWindow(att)) setPreviewAttachment(att); }}
                onDownload={() => handleDownload(att)}
                onJumpToEmail={() => handleJumpToEmail(att)}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col">
            {attachments.map((att) => (
              <AttachmentListItem
                key={att.id}
                attachment={att}
                accountLabel={isUnified ? accountMeta.get(att.account_id)?.label : undefined}
                accountColor={isUnified ? accountMeta.get(att.account_id)?.color ?? undefined : undefined}
                downloadProgress={downloadProgress.get(att.id)}
                downloadError={downloadErrors.get(att.id)}
                selected={sel.isSelected(att.id)}
                onSelect={(e) => { if (drag.didDrag()) return; sel.onItemClick(att.id, e); }}
                onOpenWithApp={() => handleOpenWithApp(att)}
                onItemMouseDown={(e) => drag.onItemMouseDown(att.id, e)}
                onItemDragStart={(e) => drag.onItemDragStart(att.id, e)}
                onItemPointerEnter={() => drag.onItemPointerEnter(att.id)}
                onPreview={() => { if (!openAttachmentPreviewWindow(att)) setPreviewAttachment(att); }}
                onDownload={() => handleDownload(att)}
                onJumpToEmail={() => handleJumpToEmail(att)}
              />
            ))}
          </div>
        )}
        {!loading && hasMore && (
          <div className="flex justify-center pt-4">
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="text-xs px-3 py-1.5 rounded-md border border-border-primary bg-bg-secondary text-text-secondary hover:text-text-primary hover:border-accent disabled:opacity-50 transition-colors"
            >
              {loadingMore
                ? t("attachments.library.loading")
                : t("attachments.library.loadMore", { shown: attachments.length, total: totalCount })}
            </button>
          </div>
        )}
      </div>

      {/* Preview modal */}
      {previewAttachment && (
        <AttachmentPreview
          attachment={previewAttachment}
          onClose={() => setPreviewAttachment(null)}
        />
      )}
    </div>
  );
}
