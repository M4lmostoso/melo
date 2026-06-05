import { Download, Eye, ExternalLink } from "lucide-react";
import { t } from "@/i18n";
import { formatFileSize, getFileIcon, canPreview } from "@/utils/fileTypeHelpers";
import type { AttachmentWithContext } from "@/services/db/attachments";

interface AttachmentListItemProps {
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

function formatShortDate(timestamp: number | null): string {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short", day: "numeric", year: "numeric",
  });
}

export function AttachmentListItem({
  attachment, accountLabel, accountColor,
  downloadProgress, downloadError,
  onPreview, onDownload, onJumpToEmail,
}: AttachmentListItemProps) {
  const previewable = canPreview(attachment.mime_type, attachment.filename);
  const senderName = attachment.from_name || attachment.from_address || t("attachments.library.unknownSender");
  const isDownloading = downloadProgress !== undefined;
  const hasError = !!downloadError;
  const pct = downloadProgress ?? 0;

  return (
    <div className="group relative flex items-center gap-3 px-3 py-2 hover:bg-bg-hover rounded-md transition-colors">
        <span className="text-lg shrink-0 w-7 text-center">{getFileIcon(attachment.mime_type, attachment.filename)}</span>

        <span className="text-sm text-text-primary truncate min-w-0 flex-1" title={attachment.filename ?? undefined}>
          {attachment.filename ?? t("attachments.library.unnamed")}
        </span>

        <span className="text-xs text-text-secondary truncate w-36 shrink-0 hidden md:block" title={senderName}>
          {senderName}
        </span>

        {accountLabel && (
          <span className="text-xs text-text-tertiary truncate w-28 shrink-0 hidden lg:flex items-center gap-1.5" title={accountLabel}>
            <span className="inline-block size-1.5 rounded-full shrink-0" style={{ backgroundColor: accountColor ?? "var(--color-accent)" }} />
            <span className="truncate">{accountLabel}</span>
          </span>
        )}

        <span className="text-xs text-text-tertiary w-24 shrink-0 text-right hidden md:block">
          {formatShortDate(attachment.date)}
        </span>

        <span className="text-xs text-text-tertiary w-16 shrink-0 text-right">
          {attachment.size != null ? formatFileSize(attachment.size) : ""}
        </span>

        <div className="flex gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          {previewable && (
            <button onClick={onPreview} className="p-1.5 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-secondary transition-colors" title={t("attachments.library.actionPreview")}>
              <Eye size={14} />
            </button>
          )}
          <button
            onClick={onDownload}
            disabled={isDownloading}
            className="p-1.5 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-secondary transition-colors disabled:opacity-40"
            title={t("attachments.library.actionDownload")}
          >
            <Download size={14} />
          </button>
          <button onClick={onJumpToEmail} className="p-1.5 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-secondary transition-colors" title={t("attachments.library.actionJumpToEmail")}>
            <ExternalLink size={14} />
          </button>
        </div>

      {/* Progress bar — absolute overlay, never changes the row height.
          Single persistent fill with a width transition so a fast 0→100 jump still
          animates; indeterminate shimmer overlays only while at 0%. */}
      {(isDownloading || hasError) && (
        <div
          className="absolute bottom-0 left-1 right-1 h-1 bg-accent/15 rounded-full overflow-hidden"
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
    </div>
  );
}
