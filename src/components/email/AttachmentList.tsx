import { useState, useCallback, useRef, useEffect } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { getAttachmentsForMessage, type DbAttachment } from "@/services/db/attachments";
import { Modal } from "@/components/ui/Modal";
import { Download, Eye, Loader2, GripVertical } from "lucide-react";
import { t } from "@/i18n";
import { formatFileSize, isImage, isPdf, isText, isOfficeDoc, isOfficeSpreadsheet, canPreview, getFileIcon } from "@/utils/fileTypeHelpers";
import { OfficeDocPreview } from "@/components/ui/OfficeDocPreview";
import { useMultiSelect } from "@/hooks/useMultiSelect";
import { useDragOut } from "@/hooks/useDragOut";
import { toAttachmentRef, openAttachmentWithDefaultApp, downloadAttachmentsToFolder, materializeAttachment } from "@/services/attachments/attachmentActions";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/ContextMenu";

/** Dedup attachments by filename+size (content-based) */
function dedup(attachments: DbAttachment[]): DbAttachment[] {
  const seen = new Set<string>();
  return attachments.filter((a) => {
    const key = `${a.filename}:${a.size}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface AttachmentListProps {
  attachments: DbAttachment[];
  referencedCids?: Set<string>;
}

export function AttachmentList({ attachments, referencedCids }: AttachmentListProps) {
  const [preview, setPreview] = useState<DbAttachment | null>(null);

  // Filter out CID images rendered in the email body and true inline parts, then dedup
  const fileAttachments = dedup(attachments.filter((a) => {
    // Skip attachments whose CID is referenced in the email body (already rendered inline)
    if (a.content_id && referencedCids?.has(a.content_id)) return false;
    // True inline: marked inline with no filename
    if (a.is_inline && !a.filename) return false;
    return true;
  }));

  const sel = useMultiSelect(fileAttachments.map((a) => a.id));
  const drag = useDragOut((id) => {
    if (sel.isSelected(id)) {
      return fileAttachments.filter((a) => sel.selectedIds.has(a.id)).map(toAttachmentRef);
    }
    const att = fileAttachments.find((a) => a.id === id);
    return att ? [toAttachmentRef(att)] : [];
  });
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  // null = idle; otherwise overall download progress 0–100 for the folder download.
  const [downloadPct, setDownloadPct] = useState<number | null>(null);

  if (fileAttachments.length === 0) return null;

  const handleKeyDown = (e: React.KeyboardEvent, att: DbAttachment) => {
    if (e.key === " ") {
      e.preventDefault();
      setPreview(att);
    } else if (e.key === "Enter") {
      e.preventDefault();
      openAttachmentWithDefaultApp(toAttachmentRef(att)).catch((err) => console.error("Open attachment failed:", err));
    }
  };

  // Right-click an item: select it (Finder-style) if not already in the selection,
  // then open the menu. Right-clicking empty space keeps the current selection.
  const openMenuForItem = (e: React.MouseEvent, att: DbAttachment) => {
    e.preventDefault();
    e.stopPropagation();
    if (!sel.isSelected(att.id)) sel.selectOnly(att.id);
    setMenuPos({ x: e.clientX, y: e.clientY });
  };
  const openMenuForArea = (e: React.MouseEvent) => {
    e.preventDefault();
    setMenuPos({ x: e.clientX, y: e.clientY });
  };

  const downloadToFolder = async (items: DbAttachment[]) => {
    setMenuPos(null);
    if (items.length === 0 || downloadPct !== null) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dir = await open({ directory: true });
    if (typeof dir !== "string" || !dir) return;
    setDownloadPct(0);

    // Blend file-level progress (one step per file) with byte-level progress of the
    // in-flight file, streamed from Rust via the shared download-progress event.
    const cur = { dbId: "", index: 0, total: items.length };
    const unlisten = await listen<{ attachmentId: string; downloaded: number; total: number }>(
      "attachment-download-progress",
      (e) => {
        if (e.payload.attachmentId !== cur.dbId) return;
        const frac = e.payload.total > 0 ? Math.min(1, e.payload.downloaded / e.payload.total) : 0;
        setDownloadPct(Math.min(99, Math.round(((cur.index + frac) / cur.total) * 100)));
      },
    );

    try {
      const { firstPath } = await downloadAttachmentsToFolder(
        items.map(toAttachmentRef),
        dir,
        ({ index, total, dbId }) => {
          cur.dbId = dbId;
          cur.index = index;
          cur.total = total;
          setDownloadPct(Math.round((index / total) * 100));
        },
      );
      setDownloadPct(100);
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(firstPath ?? dir).catch(() => {});
    } finally {
      unlisten();
      setTimeout(() => setDownloadPct(null), 1200);
    }
  };

  const selectedAttachments = fileAttachments.filter((a) => sel.isSelected(a.id));
  const menuItems: ContextMenuItem[] = [
    ...(selectedAttachments.length > 0
      ? [{
          id: "download-selected",
          label: t("email.attachmentList.downloadSelected", { count: selectedAttachments.length }),
          icon: Download,
          action: () => void downloadToFolder(selectedAttachments),
        } satisfies ContextMenuItem]
      : []),
    {
      id: "download-all",
      label: t("email.attachmentList.downloadAll", { count: fileAttachments.length }),
      icon: Download,
      action: () => void downloadToFolder(fileAttachments),
    },
  ];

  return (
    <>
      <div className="mt-3 pt-3 border-t border-border-secondary">
        <div className="text-xs text-text-tertiary mb-2">
          {fileAttachments.length !== 1
            ? t("email.attachmentList.countPlural", { count: fileAttachments.length })
            : t("email.attachmentList.count", { count: fileAttachments.length })}
        </div>

        {downloadPct !== null && (
          <div className="mb-2.5" role="progressbar" aria-valuenow={downloadPct} aria-valuemin={0} aria-valuemax={100}>
            <div className="flex items-center justify-between text-[11px] mb-1">
              <span className="flex items-center gap-1 text-accent">
                <Loader2 size={11} className="animate-spin" />
                {t("email.attachmentList.downloading")}
              </span>
              <span className="text-text-tertiary tabular-nums">{downloadPct}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
              <div
                className="h-full bg-accent rounded-full transition-[width] duration-200 ease-out"
                style={{ width: `${downloadPct}%` }}
              />
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-2" onContextMenu={openMenuForArea}>
          {fileAttachments.map((att) => {
            const prep = drag.prepState[att.id];
            const pct = drag.progress[att.id];
            const isPreparing = prep === "preparing";
            const isReady = prep === "ready";
            const dragTitle = isPreparing
              ? t("email.attachmentList.preparing")
              : isReady
                ? t("email.attachmentList.readyToDrag")
                : t("email.attachmentList.itemHint");
            return (
            <div
              key={att.id}
              role="button"
              tabIndex={0}
              draggable
              aria-selected={sel.isSelected(att.id)}
              aria-busy={isPreparing}
              title={dragTitle}
              onPointerEnter={() => drag.onItemPointerEnter(att.id)}
              onMouseDown={(e) => drag.onItemMouseDown(att.id, e)}
              onDragStart={(e) => drag.onItemDragStart(att.id, e)}
              onClick={(e) => { if (drag.didDrag()) return; sel.onItemClick(att.id, e); }}
              onContextMenu={(e) => openMenuForItem(e, att)}
              onDoubleClick={() => openAttachmentWithDefaultApp(toAttachmentRef(att)).catch((err) => console.error("Open attachment failed:", err))}
              onKeyDown={(e) => handleKeyDown(e, att)}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs rounded-md border transition-colors select-none focus:outline-none focus:ring-1 focus:ring-accent ${
                isPreparing ? "cursor-progress" : isReady ? "cursor-grab" : "cursor-pointer"
              } ${
                sel.isSelected(att.id)
                  ? "border-accent bg-accent/10"
                  : isReady
                    ? "border-accent/60 bg-bg-hover"
                    : "border-border-primary hover:bg-bg-hover"
              }`}
            >
              <span className="text-text-tertiary">{getFileIcon(att.mime_type, att.filename)}</span>
              <span className="text-text-secondary truncate max-w-[200px]">
                {att.filename ?? t("email.attachmentList.unnamed")}
              </span>
              {isPreparing ? (
                <span className="flex items-center gap-1 text-text-tertiary whitespace-nowrap tabular-nums">
                  <Loader2 size={12} className="animate-spin" />
                  {pct != null && pct >= 0 ? `${pct}%` : null}
                </span>
              ) : isReady ? (
                <GripVertical size={12} className="text-accent shrink-0" aria-label={t("email.attachmentList.readyToDrag")} />
              ) : (
                att.size != null && (
                  <span className="text-text-tertiary whitespace-nowrap">
                    {formatFileSize(att.size)}
                  </span>
                )
              )}
            </div>
            );
          })}
        </div>
      </div>

      {menuPos && (
        <ContextMenu
          items={menuItems}
          position={menuPos}
          onClose={() => setMenuPos(null)}
        />
      )}

      {preview && (
        <AttachmentPreview
          attachment={preview}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}

export function AttachmentPreview({
  attachment,
  onClose,
}: {
  attachment: DbAttachment;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [previewBytes, setPreviewBytes] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Download progress (0-100) while saving; undefined when idle. Separate red flag
  // so the bar only turns red for download failures, not preview-load errors.
  const [downloadProgress, setDownloadProgress] = useState<number | undefined>(undefined);
  const [downloadFailed, setDownloadFailed] = useState(false);
  const bytesRef = useRef<Uint8Array | null>(null);

  // Listen to Rust byte-level progress events for this attachment
  useEffect(() => {
    const unlisten = listen<{ attachmentId: string; downloaded: number; total: number }>(
      "attachment-download-progress",
      (e) => {
        if (e.payload.attachmentId !== attachment.id) return;
        const { downloaded, total } = e.payload;
        const pct = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
        setDownloadProgress(pct);
      },
    );
    return () => { unlisten.then((f) => f()); };
  }, [attachment.id]);

  const isPreviewable = canPreview(attachment.mime_type, attachment.filename);
  const isOffice = isOfficeDoc(attachment.mime_type, attachment.filename) || isOfficeSpreadsheet(attachment.mime_type, attachment.filename);

  const attachmentId = attachment.gmail_attachment_id ?? attachment.imap_part_id;
  const cachePathRef = useRef<string | null>(null);

  const fetchData = useCallback(async (): Promise<Uint8Array> => {
    if (bytesRef.current) return bytesRef.current;

    // Materialize into the unified attachment cache (single-flight, batched per
    // message, shared with drag-out and download-to-folder), then read the file
    // from disk — no base64 across the IPC bridge, no per-part IMAP fetch.
    const path = await materializeAttachment(toAttachmentRef(attachment));
    cachePathRef.current = path;
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const bytes = await readFile(path);
    bytesRef.current = bytes;
    return bytes;
  }, [attachment]);

  const handlePreviewLoad = useCallback(async () => {
    if (!attachmentId || !isPreviewable || blobUrl || previewBytes) return;

    setLoading(true);
    try {
      const bytes = await fetchData();
      if (isOffice) {
        setPreviewBytes(bytes);
      } else {
        const effectiveMime = isPdf(attachment.mime_type, attachment.filename)
          ? "application/pdf"
          : (attachment.mime_type ?? "application/octet-stream");
        const blob = new Blob([bytes.buffer as ArrayBuffer], { type: effectiveMime });
        setBlobUrl(URL.createObjectURL(blob));
      }
    } catch (err) {
      console.error("Failed to load preview:", err);
      setError("Failed to load preview");
    } finally {
      setLoading(false);
    }
  }, [attachment, isPreviewable, isOffice, blobUrl, previewBytes, fetchData]);

  useEffect(() => {
    if (isPreviewable && !blobUrl && !previewBytes && !loading && !error) {
      handlePreviewLoad();
    }
  }, [isPreviewable, blobUrl, previewBytes, loading, error, handlePreviewLoad]);

  const handleDownload = async () => {
    if (!attachmentId || saving || downloading) return;

    setSaving(true);
    let filePath: string | null = null;
    try {
      filePath = await save({
        defaultPath: attachment.filename ?? "attachment",
      });
    } finally {
      setSaving(false);
    }

    if (!filePath) return;

    setDownloading(true);
    setError(null);
    setDownloadFailed(false);
    setDownloadProgress(0);
    try {
      // Materialize into the unified cache (already there if the preview
      // loaded — instant copy), then copy to the chosen destination. Byte
      // progress still flows from Rust keyed by attachment.id while fetching.
      const src = cachePathRef.current ?? await materializeAttachment(toAttachmentRef(attachment));
      cachePathRef.current = src;
      const { copyFile } = await import("@tauri-apps/plugin-fs");
      await copyFile(src, filePath);
      setDownloadProgress(100);
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(filePath);
      setTimeout(() => setDownloadProgress(undefined), 1500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Failed to save attachment:", msg);
      setError(msg);
      setDownloadFailed(true);
      setDownloadProgress(undefined);
    } finally {
      setDownloading(false);
    }
  };

  const handleClose = () => {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    onClose();
  };

  const dlPct = downloadProgress ?? 0;
  const header = (
    <div className="relative px-4 py-3 border-b border-border-primary flex items-center justify-between shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        <span>{getFileIcon(attachment.mime_type, attachment.filename)}</span>
        <span className="text-sm font-medium text-text-primary truncate">
          {attachment.filename ?? "Unnamed"}
        </span>
        {attachment.size != null && (
          <span className="text-xs text-text-tertiary whitespace-nowrap">
            ({formatFileSize(attachment.size)})
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0 ml-4">
        <button
          onClick={handleDownload}
          disabled={saving || downloading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-accent hover:bg-accent-hover rounded-md transition-colors disabled:opacity-50"
        >
          <Download size={13} />
          {saving
            ? t("email.attachmentList.saving")
            : downloading
              ? t("email.attachmentList.downloading")
              : t("email.attachmentList.download")}
        </button>
        <button
          onClick={handleClose}
          className="text-text-tertiary hover:text-text-primary text-lg leading-none"
        >
          ×
        </button>
      </div>

      {/* Download progress bar — absolute overlay on the header's bottom edge.
          Breathing accent while waiting on the server (0%), smooth fill on real
          byte progress, solid red on failure. Mirrors the attachment library. */}
      {(downloadProgress !== undefined || downloadFailed) && (
        <div
          className="absolute bottom-0 left-0 right-0 h-1 bg-accent/15 overflow-hidden"
          title={downloadFailed ? (error ?? undefined) : dlPct > 0 ? `${dlPct}%` : t("attachments.library.actionPreparing")}
        >
          <div
            className={`h-full transition-[width] duration-300 ease-out ${downloadFailed ? "bg-red-500" : "bg-accent"}`}
            style={{ width: downloadFailed ? "100%" : `${dlPct}%` }}
          />
          {!downloadFailed && dlPct === 0 && (
            <div className="absolute inset-0 bg-accent animate-progress-breathe" />
          )}
        </div>
      )}
    </div>
  );

  return (
    <Modal
      isOpen={true}
      onClose={handleClose}
      title={attachment.filename ?? "Attachment"}
      width="w-[800px]"
      panelClassName="max-w-[90vw] max-h-[85vh] flex flex-col"
      renderHeader={header}
    >
      {/* Allow native right-click in preview (save image, copy, etc.) */}
      <div className="flex-1 overflow-auto min-h-[200px] flex items-center justify-center p-4" data-native-context-menu>
        {loading && (
          <p className="text-sm text-text-tertiary">{t("email.attachmentList.loadingPreview")}</p>
        )}
        {error && (
          <p className="text-sm text-text-tertiary">{error}</p>
        )}
        {!loading && !error && blobUrl && isImage(attachment.mime_type) && (
          <img
            src={blobUrl}
            alt={attachment.filename ?? "Attachment"}
            className="max-w-full max-h-[70vh] object-contain rounded"
          />
        )}
        {!loading && !error && blobUrl && isPdf(attachment.mime_type, attachment.filename) && (
          <iframe
            src={blobUrl}
            title={attachment.filename ?? "PDF preview"}
            className="w-full h-[70vh] border-0 rounded"
          />
        )}
        {!loading && !error && blobUrl && isText(attachment.mime_type) && (
          <TextPreview url={blobUrl} />
        )}
        {!loading && !error && previewBytes && (
          <OfficeDocPreview bytes={previewBytes} mimeType={attachment.mime_type} filename={attachment.filename ?? null} />
        )}
        {!isPreviewable && !loading && (
          <div className="flex flex-col items-center gap-3 text-text-tertiary">
            <Eye size={40} strokeWidth={1} />
            <p className="text-sm">{t("email.attachmentList.previewNotAvailable")}</p>
            <p className="text-xs">{attachment.mime_type ?? t("email.attachmentList.unknownType")}</p>
          </div>
        )}
      </div>
    </Modal>
  );
}

function TextPreview({ url }: { url: string }) {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    fetch(url).then((r) => r.text()).then(setText).catch(() => setText("Failed to load text"));
  }, [url]);

  return (
    <pre className="text-xs text-text-secondary whitespace-pre-wrap font-mono w-full max-h-[70vh] overflow-auto bg-bg-tertiary rounded p-4">
      {text ?? "Loading..."}
    </pre>
  );
}

export { getAttachmentsForMessage };
