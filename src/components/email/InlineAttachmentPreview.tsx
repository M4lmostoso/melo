import { useState, useEffect, useRef, useCallback } from "react";
import type { DbAttachment } from "@/services/db/attachments";
import { materializeAttachment, toAttachmentRef } from "@/services/attachments/attachmentActions";
import { t } from "@/i18n";
import { isImage } from "@/utils/fileTypeHelpers";

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

interface InlineAttachmentPreviewProps {
  attachments: DbAttachment[];
  referencedCids?: Set<string>;
  onAttachmentClick: (attachment: DbAttachment) => void;
}

export function InlineAttachmentPreview({
  attachments,
  referencedCids,
  onAttachmentClick,
}: InlineAttachmentPreviewProps) {
  // Filter to previewable image attachments, dedup, exclude CID-referenced.
  // PDFs are intentionally not previewed here — they're listed by AttachmentList below.
  const images = dedup(attachments.filter((a) => {
    // Skip attachments whose CID is referenced in the email body
    if (a.content_id && referencedCids?.has(a.content_id)) return false;
    if (a.is_inline && !a.filename) return false;
    return isImage(a.mime_type);
  }));

  if (images.length === 0) return null;

  return (
    <div className="mt-3">
      {/* Image thumbnails */}
      <div className="flex flex-wrap gap-2 mb-2">
        {images.map((att) => (
          <ImageThumbnail
            key={att.id}
            attachment={att}
            onClick={() => onAttachmentClick(att)}
          />
        ))}
      </div>
    </div>
  );
}

function ImageThumbnail({
  attachment,
  onClick,
}: {
  attachment: DbAttachment;
  onClick: () => void;
}) {
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const observerRef = useRef<HTMLDivElement | null>(null);
  const loadedRef = useRef(false);

  const loadThumbnail = useCallback(async () => {
    if (loadedRef.current || (!attachment.gmail_attachment_id && !attachment.imap_part_id)) return;
    loadedRef.current = true;
    setLoading(true);

    try {
      // Materialize into the unified attachment cache (single-flight, batched
      // per message, shared with preview/drag/download), then serve the file
      // natively via the asset protocol — no base64 IPC, no blob copy in JS.
      const path = await materializeAttachment(toAttachmentRef(attachment));
      const { convertFileSrc } = await import("@tauri-apps/api/core");
      setThumbnailUrl(convertFileSrc(path));
    } catch (err) {
      console.error("Failed to load thumbnail:", err);
    } finally {
      setLoading(false);
    }
  }, [attachment]);

  // Lazy load via IntersectionObserver
  useEffect(() => {
    const el = observerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          loadThumbnail();
          observer.disconnect();
        }
      },
      { threshold: 0.1 },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [loadThumbnail]);

  return (
    <div ref={observerRef}>
      <button
        onClick={onClick}
        className="block rounded-md overflow-hidden border border-border-secondary hover:border-accent transition-colors"
        title={attachment.filename ?? t("email.inlineAttachment.image")}
      >
        {loading && (
          <div className="w-[200px] h-[120px] bg-bg-tertiary animate-pulse flex items-center justify-center">
            <span className="text-xs text-text-tertiary">{t("email.inlineAttachment.loading")}</span>
          </div>
        )}
        {thumbnailUrl && (
          <img
            src={thumbnailUrl}
            alt={attachment.filename ?? t("email.inlineAttachment.image")}
            className="max-w-[200px] max-h-[200px] object-cover"
          />
        )}
        {!loading && !thumbnailUrl && (
          <div className="w-[200px] h-[120px] bg-bg-tertiary flex items-center justify-center">
            <span className="text-xs text-text-tertiary">{t("email.inlineAttachment.image")}</span>
          </div>
        )}
      </button>
    </div>
  );
}

