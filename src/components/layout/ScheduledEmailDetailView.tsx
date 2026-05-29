import { useState, useRef, useEffect, useMemo } from "react";
import { Clock, Edit2, RotateCcw, Trash2 } from "lucide-react";
import { getFileIcon, formatFileSize } from "@/utils/fileTypeHelpers";
import { useUIStore } from "@/stores/uiStore";
import { useComposerStore } from "@/stores/composerStore";
import { useLabelStore } from "@/stores/labelStore";
import { useAccountStore } from "@/stores/accountStore";
import { updateScheduledEmailStatus, updateScheduledTime } from "@/services/db/scheduledEmails";
import { sanitizeHtml } from "@/utils/sanitize";
import { DateTimePickerDialog } from "@/components/ui/DateTimePickerDialog";
import { getSchedulePresets } from "@/utils/schedulePresets";
import { t } from "@/i18n";

function formatScheduledAt(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = date.toDateString() === tomorrow.toDateString();
  const timeStr = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (isToday) return t("layout.scheduledPanel.todayAt", { time: timeStr });
  if (isTomorrow) return t("layout.scheduledPanel.tomorrowAt", { time: timeStr });
  return (
    date.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    }) +
    " at " +
    timeStr
  );
}

export function ScheduledEmailDetailView() {
  const email = useUIStore((s) => s.selectedScheduledEmail);
  const setSelectedScheduledEmail = useUIStore((s) => s.setSelectedScheduledEmail);
  const openComposer = useComposerStore((s) => s.openComposer);
  const refreshScheduledCounts = useLabelStore((s) => s.refreshScheduledCounts);
  const accounts = useAccountStore((s) => s.accounts);
  const [showRescheduler, setShowRescheduler] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Re-render iframe content when email changes
  useEffect(() => {
    if (!iframeRef.current || !email) return;
    const doc = iframeRef.current.contentDocument;
    if (!doc) return;
    const sanitized = sanitizeHtml(email.body_html);
    doc.open();
    doc.write(`<!DOCTYPE html><html><head>
      <meta charset="utf-8"/>
      <meta name="color-scheme" content="light dark"/>
      <style>
        * { box-sizing: border-box; }
        body {
          margin: 0;
          padding: 16px 20px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          font-size: 14px;
          line-height: 1.6;
          color: #1a1a1a;
          background: transparent;
          word-break: break-word;
          overflow-wrap: break-word;
        }
        img { max-width: 100%; height: auto; }
        a { color: #4f6ef7; }
        blockquote {
          margin: 8px 0;
          padding-left: 12px;
          border-left: 3px solid #d1d5db;
          color: #6b7280;
        }
        @media (prefers-color-scheme: dark) {
          body { color: #e5e7eb; }
          a { color: #818cf8; }
          blockquote { border-color: #374151; color: #9ca3af; }
        }
      </style>
    </head><body>${sanitized}</body></html>`);
    doc.close();

    // Auto-resize iframe to fit content
    const resize = () => {
      if (iframeRef.current?.contentDocument?.body) {
        iframeRef.current.style.height =
          iframeRef.current.contentDocument.body.scrollHeight + "px";
      }
    };
    iframeRef.current.onload = resize;
    setTimeout(resize, 100);
  }, [email]);

  const attachments = useMemo(() => {
    if (!email?.attachment_paths) return [];
    try {
      return JSON.parse(email.attachment_paths) as { filename: string; mimeType: string; content: string }[];
    } catch {
      return [];
    }
  }, [email?.attachment_paths]);

  if (!email) return null;

  const recipients = email.to_addresses.split(",").map((s) => s.trim()).filter(Boolean);
  const ccList = email.cc_addresses?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  const bccList = email.bcc_addresses?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];

  const handleEdit = () => {
    const to = email.to_addresses.split(",").map((s) => s.trim()).filter(Boolean);
    const cc = email.cc_addresses ? email.cc_addresses.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const bcc = email.bcc_addresses ? email.bcc_addresses.split(",").map((s) => s.trim()).filter(Boolean) : [];
    openComposer({
      mode: "new",
      to,
      cc,
      bcc,
      subject: email.subject ?? "",
      bodyHtml: email.body_html,
      threadId: email.thread_id,
      accountId: email.account_id,
    });
    updateScheduledEmailStatus(email.id, "cancelled")
      .then(() => refreshScheduledCounts(accounts.map((a) => a.id)))
      .catch(console.error);
    window.dispatchEvent(new CustomEvent("velo-scheduled-removed", { detail: { id: email.id } }));
    setSelectedScheduledEmail(null);
  };

  const handleCancel = async () => {
    setCancelling(true);
    try {
      await updateScheduledEmailStatus(email.id, "cancelled");
      window.dispatchEvent(new CustomEvent("velo-scheduled-removed", { detail: { id: email.id } }));
      setSelectedScheduledEmail(null);
      refreshScheduledCounts(accounts.map((a) => a.id)).catch(console.error);
    } finally {
      setCancelling(false);
    }
  };

  const handleReschedule = async (newTimestamp: number) => {
    await updateScheduledTime(email.id, newTimestamp);
    setSelectedScheduledEmail({ ...email, scheduled_at: newTimestamp });
    setShowRescheduler(false);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Action bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border-primary shrink-0 bg-bg-primary/80">
        <button
          onClick={handleEdit}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-accent text-white hover:bg-accent-hover transition-colors"
        >
          <Edit2 size={13} />
          {t("layout.scheduledPanel.edit")}
        </button>
        <button
          onClick={() => setShowRescheduler(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border border-border-primary text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
        >
          <RotateCcw size={13} />
          {t("layout.scheduledPanel.editSchedule")}
        </button>
        <div className="flex-1" />
        <button
          onClick={handleCancel}
          disabled={cancelling}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border border-danger/30 text-danger hover:bg-danger/10 transition-colors disabled:opacity-50"
        >
          <Trash2 size={13} />
          {cancelling ? t("layout.scheduledPanel.cancelling") : t("layout.scheduledPanel.cancelSchedule")}
        </button>
      </div>

      {/* Subject + scheduled badge */}
      <div data-tauri-drag-region className="px-6 py-4 border-b border-border-primary shrink-0">
        <h1 className="text-lg font-semibold text-text-primary">
          {email.subject ?? t("layout.scheduledPanel.noSubject")}
        </h1>
        <div className="flex items-center gap-1.5 mt-1.5">
          <Clock size={12} className="text-accent shrink-0" />
          <span className="text-xs font-medium text-accent">
            {formatScheduledAt(email.scheduled_at)}
          </span>
        </div>
      </div>

      {/* Recipients metadata */}
      <div className="px-6 py-3 border-b border-border-secondary shrink-0 space-y-1.5">
        <div className="flex gap-3 text-sm">
          <span className="w-8 shrink-0 text-right text-text-tertiary text-xs pt-0.5">
            {t("layout.scheduledPanel.labelTo")}
          </span>
          <span className="text-text-primary text-sm">{recipients.join(", ")}</span>
        </div>
        {ccList.length > 0 && (
          <div className="flex gap-3 text-sm">
            <span className="w-8 shrink-0 text-right text-text-tertiary text-xs pt-0.5">
              {t("layout.scheduledPanel.labelCc")}
            </span>
            <span className="text-text-secondary text-sm">{ccList.join(", ")}</span>
          </div>
        )}
        {bccList.length > 0 && (
          <div className="flex gap-3 text-sm">
            <span className="w-8 shrink-0 text-right text-text-tertiary text-xs pt-0.5">
              {t("layout.scheduledPanel.labelBcc")}
            </span>
            <span className="text-text-secondary text-sm">{bccList.join(", ")}</span>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        <iframe
          ref={iframeRef}
          sandbox="allow-same-origin"
          className="w-full border-none block min-h-[200px]"
          title="scheduled-email-body"
        />
        {attachments.length > 0 && (
          <div className="px-6 pt-0 pb-4 border-t border-border-secondary mt-2">
            <div className="text-xs text-text-tertiary mb-2 pt-3">
              {attachments.length !== 1
                ? t("email.attachmentList.countPlural", { count: attachments.length })
                : t("email.attachmentList.count", { count: attachments.length })}
            </div>
            <div className="flex flex-wrap gap-2">
              {attachments.map((att, i) => {
                const sizeBytes = Math.round((att.content.length * 3) / 4);
                return (
                  <div
                    key={i}
                    className="flex items-center gap-2 px-3 py-1.5 text-xs rounded-md border border-border-primary bg-bg-secondary"
                  >
                    <span className="text-text-tertiary">{getFileIcon(att.mimeType, att.filename)}</span>
                    <span className="text-text-secondary truncate max-w-[200px]">{att.filename}</span>
                    <span className="text-text-tertiary whitespace-nowrap">{formatFileSize(sizeBytes)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {showRescheduler && (
        <DateTimePickerDialog
          isOpen={true}
          onClose={() => setShowRescheduler(false)}
          title={t("layout.scheduledPanel.rescheduleTitle")}
          presets={getSchedulePresets({
            tomorrowMorning: "layout.scheduledPanel.tomorrowMorning",
            tomorrowAfternoon: "layout.scheduledPanel.tomorrowAfternoon",
            mondayMorning: "layout.scheduledPanel.mondayMorning",
          })}
          onSelect={handleReschedule}
          submitLabel={t("layout.scheduledPanel.rescheduleSubmit")}
          zIndex="z-[60]"
        />
      )}
    </div>
  );
}
