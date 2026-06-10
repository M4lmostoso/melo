import { useEffect, useState, useCallback } from "react";
import { X, RotateCcw, AlertCircle, Clock, Send, Loader2, Pencil } from "lucide-react";
import { getOutgoingDbEmails, type OutgoingDbEmail } from "@/services/db/outgoing";
import { parseRawEmailFull } from "@/utils/rawEmailParser";
import { deleteOperation, retryOperation } from "@/services/db/pendingOperations";
import { triggerQueueFlush } from "@/services/queue/queueProcessor";
import { useAccountStore } from "@/stores/accountStore";
import { useComposerStore } from "@/stores/composerStore";
import { useOutgoingStore } from "@/stores/outgoingStore";
import { EmptyState } from "@/components/ui/EmptyState";
import { GenericEmptyIllustration } from "@/components/ui/illustrations";
import { t } from "@/i18n";

interface OutgoingQueueViewProps {
  accountId: string | null;
}

// In-flight send (SMTP + Sent APPEND running right now, or the 5s undo window). Lives in the
// in-memory outgoing store, not pending_operations — it's a pure transient state that
// disappears the instant the send completes (→ message appears in Sent).
function InFlightItem({ subject, recipients }: { subject: string; recipients: string }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3 border-b border-border-secondary">
      <div className="mt-0.5 shrink-0">
        <Loader2 size={16} className="text-accent animate-spin" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-sm font-medium text-text-primary truncate">
            {subject || t("composer.noSubject")}
          </span>
          <span className="text-[0.6rem] font-medium px-1.5 py-0.5 rounded-full shrink-0 bg-accent/10 text-accent">
            {t("emailList.outgoingQueue.sending")}
          </span>
        </div>
        <div className="text-xs text-text-tertiary truncate">
          {t("emailList.outgoingQueue.to")}: {recipients}
        </div>
      </div>
    </div>
  );
}

function OutgoingItem({
  email,
  onCancel,
  onRetry,
  onEdit,
}: {
  email: OutgoingDbEmail;
  onCancel: () => void;
  onRetry: () => void;
  onEdit: () => void;
}) {
  const isFailed = email.status === "failed";
  const recipientList = email.to.join(", ");

  return (
    <div className="flex items-start gap-3 px-4 py-3 border-b border-border-secondary hover:bg-bg-hover transition-colors">
      <div className="mt-0.5 shrink-0">
        {isFailed ? (
          <AlertCircle size={16} className="text-danger" />
        ) : (
          <Clock size={16} className="text-amber-500" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-sm font-medium text-text-primary truncate">
            {email.subject || t("composer.noSubject")}
          </span>
          <span
            className={`text-[0.6rem] font-medium px-1.5 py-0.5 rounded-full shrink-0 ${
              isFailed
                ? "bg-danger/10 text-danger"
                : "bg-amber-500/10 text-amber-500"
            }`}
          >
            {isFailed
              ? t("emailList.outgoingQueue.failed")
              : t("emailList.outgoingQueue.pending")}
          </span>
        </div>
        <div className="text-xs text-text-tertiary truncate">
          {t("emailList.outgoingQueue.to")}: {recipientList}
        </div>
        {email.retryCount > 0 && (
          <div className="text-xs text-text-tertiary mt-0.5">
            {t("emailList.outgoingQueue.retryCount", { count: email.retryCount })}
          </div>
        )}
        {isFailed && email.errorMessage && (
          <div className="text-xs text-danger mt-0.5 truncate" title={email.errorMessage}>
            {email.errorMessage}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {isFailed && (
          <button
            onClick={onRetry}
            className="p-1.5 rounded hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
            title={t("emailList.outgoingQueue.retryNow")}
          >
            <RotateCcw size={14} />
          </button>
        )}
        <button
          onClick={onEdit}
          className="p-1.5 rounded hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
          title={t("emailList.outgoingQueue.edit")}
        >
          <Pencil size={14} />
        </button>
        <button
          onClick={onCancel}
          className="p-1.5 rounded hover:bg-danger/10 text-text-secondary hover:text-danger transition-colors"
          title={t("emailList.outgoingQueue.cancel")}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

export function OutgoingQueueView({ accountId }: OutgoingQueueViewProps) {
  const [emails, setEmails] = useState<OutgoingDbEmail[]>([]);
  const [loading, setLoading] = useState(true);
  const accounts = useAccountStore((s) => s.accounts);
  const inFlightAll = useOutgoingStore((s) => s.emails);
  const inFlight = accountId
    ? inFlightAll.filter((e) => e.accountId === accountId)
    : inFlightAll;

  const load = useCallback(async () => {
    const accountIds = accountId ? [accountId] : accounts.map((a) => a.id);
    const items = await getOutgoingDbEmails(accountIds);
    setEmails(items);
    setLoading(false);
  }, [accountId, accounts]);

  useEffect(() => {
    load();
    const handler = () => { load().catch(console.error); };
    window.addEventListener("melo-sync-done", handler);
    return () => window.removeEventListener("melo-sync-done", handler);
  }, [load]);

  const handleCancel = async (id: string) => {
    await deleteOperation(id);
    setEmails((prev) => prev.filter((e) => e.id !== id));
  };

  const handleRetry = async (email: OutgoingDbEmail) => {
    await retryOperation(email.id);
    setEmails((prev) =>
      prev.map((e) =>
        e.id === email.id ? { ...e, status: "pending", retryCount: 0, errorMessage: null } : e,
      ),
    );
    triggerQueueFlush().catch(console.error);
  };

  // Pull the queued/failed send back into the composer as an editable draft, then drop it
  // from the queue so it isn't also sent automatically. parseRawEmailFull recovers
  // everything from the stored raw: recipients incl. BCC, body with re-inlined images,
  // and attachments with their content.
  const handleEdit = async (email: OutgoingDbEmail) => {
    await deleteOperation(email.id);
    setEmails((prev) => prev.filter((e) => e.id !== email.id));
    const full = parseRawEmailFull(email.raw);
    useComposerStore.getState().openComposer({
      to: full.to,
      cc: full.cc,
      bcc: full.bcc,
      subject: full.subject,
      bodyHtml: full.bodyHtml,
      threadId: email.threadId,
      inReplyToMessageId: full.inReplyTo,
      references: full.references,
      accountId: email.accountId,
      attachments: full.attachments.map((a) => ({
        id: crypto.randomUUID(),
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
        content: a.content,
      })),
    });
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (emails.length === 0 && inFlight.length === 0) {
    return (
      <EmptyState
        illustration={GenericEmptyIllustration}
        title={t("emailList.emptyOutgoing")}
      />
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-4 py-2 flex items-center gap-2 border-b border-border-primary">
        <Send size={14} className="text-amber-500" />
        <span className="text-xs font-medium text-text-secondary uppercase tracking-wider">
          {t("sidebar.nav.outgoing", { defaultValue: "Outgoing" })}
        </span>
        <span className="ml-auto text-xs text-text-tertiary">{emails.length + inFlight.length}</span>
      </div>
      {inFlight.map((email) => (
        <InFlightItem
          key={email.id}
          subject={email.subject}
          recipients={email.to.join(", ")}
        />
      ))}
      {emails.map((email) => (
        <OutgoingItem
          key={email.id}
          email={email}
          onCancel={() => handleCancel(email.id)}
          onRetry={() => handleRetry(email)}
          onEdit={() => handleEdit(email)}
        />
      ))}
    </div>
  );
}
