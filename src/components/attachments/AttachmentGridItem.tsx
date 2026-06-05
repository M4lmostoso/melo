import { Download, Eye, ExternalLink } from "lucide-react";
import { t } from "@/i18n";
import { formatFileSize, getFileIcon, canPreview } from "@/utils/fileTypeHelpers";
import type { AttachmentWithContext } from "@/services/db/attachments";

interface AttachmentGridItemProps {
  attachment: AttachmentWithContext;
  accountLabel?: string;
  accountColor?: string;
  /** 0-100 while downloading; undefined when idle */
  downloadProgress?: number;
  /** set when last download failed */
  downloadError?: string;
  onPreview: () => void;
  onDownload: () => void;
  onJumpToEmail: () => void;
}

function formatRelativeDate(timestamp: number | null): string {
  if (!timestamp) return "";
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function AttachmentGridItem({
  attachment, accountLabel, accountColor,
  downloadProgress, downloadError,
  onPreview, onDownload, onJumpToEmail,
}: AttachmentGridItemProps) {
  const previewable = canPreview(attachment.mime_type, attachment.filename);
  const senderName = attachment.from_name || attachment.from_address || t("attachments.library.unknownSender");
  const isDownloading = downloadProgress !== undefined;
  const hasError = !!downloadError;
  const pct = downloadProgress ?? 0;

  return (
    <div className="group relative flex flex-col border border-border-primary rounded-lg hover:border-border-secondary hover:bg-bg-hover transition-colors overflow-hidden">
      {/* Icon area */}
      <button
        onClick={previewable ? onPreview : onDownload}
        className="flex items-center justify-center h-24 bg-bg-secondary text-3xl"
      >
        {getFileIcon(attachment.mime_type, attachment.filename)}
      </button>

      {/* Info */}
      <div className="px-3 py-2 flex flex-col gap-0.5 min-w-0">
        <span className="text-xs font-medium text-text-primary truncate" title={attachment.filename ?? undefined}>
          {attachment.filename ?? t("attachments.library.unnamed")}
        </span>
        <span className="text-[0.6875rem] text-text-tertiary truncate" title={senderName}>
          {senderName}
        </span>
        {accountLabel && (
          <span className="flex items-center gap-1 text-[0.6875rem] text-text-tertiary truncate" title={accountLabel}>
            <span className="inline-block size-1.5 rounded-full shrink-0" style={{ backgroundColor: accountColor ?? "var(--color-accent)" }} />
            <span className="truncate">{accountLabel}</span>
          </span>
        )}
        <div className="flex items-center gap-2 text-[0.6875rem] text-text-tertiary">
          {attachment.size != null && <span>{formatFileSize(attachment.size)}</span>}
          {attachment.date && <span>{formatRelativeDate(attachment.date)}</span>}
        </div>
      </div>

      {/* Progress bar — absolute overlay, never changes the card height.
          A single persistent fill element with a width transition, so even a fast
          0→100 jump animates as a smooth fill. An indeterminate shimmer overlays it
          only while at 0% (waiting on the server) so activity is visible immediately. */}
      {(isDownloading || hasError) && (
        <div
          className="absolute bottom-0 left-0 right-0 h-1 bg-accent/15 overflow-hidden"
          title={hasError ? downloadError : pct > 0 ? `${pct}%` : t("attachments.library.actionPreparing")}
        >
          <div
            className={`h-full transition-[width] duration-300 ease-out ${hasError ? "bg-red-500" : "bg-accent"}`}
            style={{ width: hasError ? "100%" : `${pct}%` }}
          />
          {!hasError && pct === 0 && (
            <div className="absolute inset-0 bg-accent animate-progress-breathe" />
          )}
        </div>
      )}

      {/* Hover actions */}
      <div className="absolute top-1.5 right-1.5 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {previewable && (
          <button
            onClick={onPreview}
            className="p-1.5 rounded-md bg-bg-primary/90 border border-border-primary text-text-secondary hover:text-text-primary transition-colors"
            title={t("attachments.library.actionPreview")}
          >
            <Eye size={13} />
          </button>
        )}
        <button
          onClick={onDownload}
          disabled={isDownloading}
          className="p-1.5 rounded-md bg-bg-primary/90 border border-border-primary text-text-secondary hover:text-text-primary transition-colors disabled:opacity-40"
          title={t("attachments.library.actionDownload")}
        >
          <Download size={13} />
        </button>
        <button
          onClick={onJumpToEmail}
          className="p-1.5 rounded-md bg-bg-primary/90 border border-border-primary text-text-secondary hover:text-text-primary transition-colors"
          title={t("attachments.library.actionJumpToEmail")}
        >
          <ExternalLink size={13} />
        </button>
      </div>
    </div>
  );
}
