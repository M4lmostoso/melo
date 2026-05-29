import { useEffect, useState, useCallback } from "react";
import { Clock, Trash2, Paperclip } from "lucide-react";
import {
  getScheduledEmailsByAccounts,
  getScheduledEmailsForAccount,
  updateScheduledEmailStatus,
  type DbScheduledEmail,
} from "@/services/db/scheduledEmails";
import { useAccountStore } from "@/stores/accountStore";
import { useUIStore } from "@/stores/uiStore";
import { useLabelStore } from "@/stores/labelStore";
import { EmptyState } from "@/components/ui/EmptyState";
import { ScheduledEmptyIllustration } from "@/components/ui/illustrations";
import { t } from "@/i18n";

interface ScheduledEmailListViewProps {
  accountId: string | null;
}

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
      weekday: "short",
      month: "short",
      day: "numeric",
      year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    }) +
    " at " +
    timeStr
  );
}

function ScheduledItem({
  email,
  isSelected,
  onClick,
  onCancelQuick,
}: {
  email: DbScheduledEmail;
  isSelected: boolean;
  onClick: () => void;
  onCancelQuick: (e: React.MouseEvent) => void;
}) {
  const recipients = email.to_addresses
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return (
    <div
      onClick={onClick}
      className={`flex items-start gap-3 px-4 py-3 border-b border-border-secondary cursor-pointer transition-colors ${
        isSelected ? "bg-accent/10" : "hover:bg-bg-hover"
      }`}
    >
      <div className="mt-0.5 shrink-0">
        <Clock size={16} className="text-accent" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-sm font-medium text-text-primary truncate">
            {email.subject || t("composer.noSubject")}
          </span>
        </div>
        <div className="text-xs text-text-tertiary truncate">
          {t("layout.scheduledPanel.labelTo")}: {recipients.join(", ")}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-accent">
            {formatScheduledAt(email.scheduled_at)}
          </span>
          {email.attachment_paths && (
            <Paperclip size={11} className="text-text-tertiary shrink-0" />
          )}
        </div>
      </div>

      <button
        onClick={onCancelQuick}
        className="p-1.5 rounded hover:bg-danger/10 text-text-tertiary hover:text-danger transition-colors shrink-0"
        title={t("layout.scheduledPanel.cancelSchedule")}
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

export function ScheduledEmailListView({ accountId }: ScheduledEmailListViewProps) {
  const [emails, setEmails] = useState<DbScheduledEmail[]>([]);
  const [loading, setLoading] = useState(true);
  const accounts = useAccountStore((s) => s.accounts);
  const selectedScheduledEmail = useUIStore((s) => s.selectedScheduledEmail);
  const setSelectedScheduledEmail = useUIStore((s) => s.setSelectedScheduledEmail);
  const refreshScheduledCounts = useLabelStore((s) => s.refreshScheduledCounts);

  const load = useCallback(async () => {
    try {
      let items: DbScheduledEmail[];
      if (accountId) {
        items = await getScheduledEmailsForAccount(accountId);
      } else {
        const allIds = accounts.map((a) => a.id);
        items = await getScheduledEmailsByAccounts(allIds);
      }
      setEmails(items);
    } catch (err) {
      console.error("Failed to load scheduled emails:", err);
    } finally {
      setLoading(false);
    }
  }, [accountId, accounts]);

  useEffect(() => {
    load();
    const syncHandler = () => { load(); };
    const removeHandler = (e: Event) => {
      const { id } = (e as CustomEvent<{ id: string }>).detail;
      setEmails((prev) => prev.filter((em) => em.id !== id));
    };
    window.addEventListener("velo-sync-done", syncHandler);
    window.addEventListener("velo-scheduled-removed", removeHandler);
    return () => {
      window.removeEventListener("velo-sync-done", syncHandler);
      window.removeEventListener("velo-scheduled-removed", removeHandler);
    };
  }, [load]);

  // Clear selection when navigating away or when the selected email is removed
  useEffect(() => {
    return () => { setSelectedScheduledEmail(null); };
  }, [setSelectedScheduledEmail]);

  const handleCancelQuick = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await updateScheduledEmailStatus(id, "cancelled");
    setEmails((prev) => prev.filter((em) => em.id !== id));
    if (selectedScheduledEmail?.id === id) setSelectedScheduledEmail(null);
    refreshScheduledCounts(accounts.map((a) => a.id)).catch(console.error);
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (emails.length === 0) {
    return (
      <EmptyState
        illustration={ScheduledEmptyIllustration}
        title={t("layout.emailList.emptyScheduled.title")}
        subtitle={t("layout.emailList.emptyScheduled.subtitle")}
      />
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {emails.map((email) => (
        <ScheduledItem
          key={email.id}
          email={email}
          isSelected={selectedScheduledEmail?.id === email.id}
          onClick={() => setSelectedScheduledEmail(email)}
          onCancelQuick={(e) => handleCancelQuick(e, email.id)}
        />
      ))}
    </div>
  );
}

