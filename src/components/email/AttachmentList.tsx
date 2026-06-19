import { useState, useCallback, useRef, useEffect } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { getAttachmentsForMessage, type DbAttachment } from "@/services/db/attachments";
import { getEmailProvider } from "@/services/email/providerFactory";
import { Modal } from "@/components/ui/Modal";
import { Download, Eye } from "lucide-react";
import { t } from "@/i18n";
import { formatFileSize, isImage, isPdf, isText, isOfficeDoc, isOfficeSpreadsheet, canPreview, getFileIcon } from "@/utils/fileTypeHelpers";
import { OfficeDocPreview } from "@/components/ui/OfficeDocPreview";
import { useMultiSelect } from "@/hooks/useMultiSelect";
import { useDragOut } from "@/hooks/useDragOut";
import { toAttachmentRef, openAttachmentWithDefaultApp } from "@/services/attachments/attachmentActions";

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
  accountId: string;
  messageId: string;
  attachments: DbAttachment[];
  referencedCids?: Set<string>;
}

export function AttachmentList({ accountId, messageId, attachments, referencedCids }: AttachmentListProps) {
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

  return (
    <>
      <div className="mt-3 pt-3 border-t border-border-secondary">
        <div className="text-xs text-text-tertiary mb-2">
          {fileAttachments.length !== 1
            ? t("email.attachmentList.countPlural", { count: fileAttachments.length })
            : t("email.attachmentList.count", { count: fileAttachments.length })}
        </div>
        <div className="flex flex-wrap gap-2">
          {fileAttachments.map((att) => (
            <div
              key={att.id}
              role="button"
              tabIndex={0}
              draggable
              aria-selected={sel.isSelected(att.id)}
              title={t("email.attachmentList.itemHint")}
              onMouseDown={(e) => drag.onItemMouseDown(att.id, e)}
              onDragStart={(e) => drag.onItemDragStart(att.id, e)}
              onClick={(e) => { if (drag.didDrag()) return; sel.onItemClick(att.id, e); }}
              onDoubleClick={() => openAttachmentWithDefaultApp(toAttachmentRef(att)).catch((err) => console.error("Open attachment failed:", err))}
              onKeyDown={(e) => handleKeyDown(e, att)}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs rounded-md border transition-colors cursor-pointer select-none focus:outline-none focus:ring-1 focus:ring-accent ${
                sel.isSelected(att.id)
                  ? "border-accent bg-accent/10"
                  : "border-border-primary hover:bg-bg-hover"
              }`}
            >
              <span className="text-text-tertiary">{getFileIcon(att.mime_type, att.filename)}</span>
              <span className="text-text-secondary truncate max-w-[200px]">
                {att.filename ?? t("email.attachmentList.unnamed")}
              </span>
              {att.size != null && (
                <span className="text-text-tertiary whitespace-nowrap">
                  {formatFileSize(att.size)}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      {preview && (
        <AttachmentPreview
          attachment={preview}
          accountId={accountId}
          messageId={messageId}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}

export function AttachmentPreview({
  attachment,
  accountId,
  messageId,
  onClose,
}: {
  attachment: DbAttachment;
  accountId: string;
  messageId: string;
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

  const fetchData = useCallback(async (): Promise<Uint8Array> => {
    if (bytesRef.current) return bytesRef.current;

    const provider = await getEmailProvider(accountId);
    const response = await provider.fetchAttachment(messageId, attachmentId!);

    // Normalize URL-safe base64 (Gmail API) to standard base64
    const base64 = response.data.replace(/-/g, "+").replace(/_/g, "/");
    const binaryStr = atob(base64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    bytesRef.current = bytes;
    return bytes;
  }, [accountId, messageId, attachmentId]);

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
      const provider = await getEmailProvider(accountId);
      await provider.downloadAttachmentToPath(messageId, attachmentId, filePath, attachment.id, attachment.size ?? 0);
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
