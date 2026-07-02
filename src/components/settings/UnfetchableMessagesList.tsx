import { useCallback, useEffect, useState } from "react";
import { t } from "@/i18n";
import { AlertTriangle, Eye, EyeOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { formatFullDate } from "@/utils/date";
import {
  listUnfetchableMessages,
  setUnfetchableIgnored,
  getUnfetchableCountForAccount,
  getUnfetchableMaxRetries,
  type UnfetchableMessageEntry,
} from "@/services/db/unfetchableUids";
import { useUIStore } from "@/stores/uiStore";

interface UnfetchableMessagesListProps {
  /** Restrict to one account (warning dialog); omit for all accounts (Settings). */
  accountId?: string;
  /** Show the owning account's email on each row (useful in the cross-account Settings list). */
  showAccount?: boolean;
}

function truncate(s: string, max = 60): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Where the missing message sits, inferred from its nearest locally-stored neighbours. */
function contextLine(e: UnfetchableMessageEntry): string {
  const prev = e.prevSubject ? truncate(e.prevSubject) : null;
  const next = e.nextSubject ? truncate(e.nextSubject) : null;
  if (prev && next) {
    return t("unfetchableMessages.contextBetween", {
      prev,
      prevDate: formatFullDate(e.prevDate!),
      next,
      nextDate: formatFullDate(e.nextDate!),
    });
  }
  if (prev) {
    return t("unfetchableMessages.contextAfter", { prev, prevDate: formatFullDate(e.prevDate!) });
  }
  if (next) {
    return t("unfetchableMessages.contextBefore", { next, nextDate: formatFullDate(e.nextDate!) });
  }
  return t("unfetchableMessages.contextUnknown");
}

/**
 * Detail list of messages the server repeatedly refused to serve, with an
 * ignore/restore toggle per entry. Ignored entries stop counting toward the
 * sidebar sync warning but stay listed here for restoring.
 */
export function UnfetchableMessagesList({ accountId, showAccount = false }: UnfetchableMessagesListProps) {
  const [entries, setEntries] = useState<UnfetchableMessageEntry[] | null>(null);
  const setAccountSyncHealth = useUIStore((s) => s.setAccountSyncHealth);

  const reload = useCallback(async () => {
    const max = await getUnfetchableMaxRetries();
    setEntries(await listUnfetchableMessages(max, accountId));
  }, [accountId]);

  useEffect(() => {
    reload().catch(() => setEntries([]));
  }, [reload]);

  const handleToggle = async (entry: UnfetchableMessageEntry) => {
    await setUnfetchableIgnored(entry.accountId, entry.folderPath, entry.uid, !entry.ignored);
    await reload();
    // Refresh the sidebar warning count for the affected account right away.
    const max = await getUnfetchableMaxRetries();
    const count = await getUnfetchableCountForAccount(entry.accountId, max);
    setAccountSyncHealth(entry.accountId, { unfetchableCount: count });
  };

  if (entries === null) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 size={16} className="animate-spin text-text-tertiary" />
      </div>
    );
  }

  if (entries.length === 0) {
    return <p className="text-xs text-text-tertiary py-1">{t("unfetchableMessages.empty")}</p>;
  }

  return (
    <div>
      {entries.map((e) => (
        <div
          key={`${e.accountId}-${e.folderPath}-${e.uid}`}
          className="flex items-start gap-3 py-2.5 border-b border-border-primary last:border-0"
        >
          <AlertTriangle
            size={15}
            className={`shrink-0 mt-0.5 ${e.ignored ? "text-text-tertiary" : "text-amber-500"}`}
          />
          <div className="flex-1 min-w-0 space-y-0.5">
            <p className="text-sm text-text-primary truncate">
              {t("unfetchableMessages.entryLine", { uid: e.uid, folder: e.folderPath })}
              {showAccount && (
                <span className="text-text-tertiary"> — {e.accountEmail}</span>
              )}
              {e.ignored && (
                <span className="ml-2 text-[0.625rem] uppercase tracking-wide bg-bg-tertiary text-text-tertiary px-1.5 py-0.5 rounded">
                  {t("unfetchableMessages.ignoredBadge")}
                </span>
              )}
            </p>
            <p className="text-xs text-text-tertiary">
              {t("unfetchableMessages.attemptsLine", {
                count: e.attempts,
                date: formatFullDate(e.lastAttemptAt),
              })}
            </p>
            <p className="text-xs text-text-secondary">{contextLine(e)}</p>
          </div>
          <Button
            size="xs"
            variant="ghost"
            icon={e.ignored ? <Eye size={12} /> : <EyeOff size={12} />}
            onClick={() => handleToggle(e)}
            className="shrink-0 border border-border-primary"
          >
            {e.ignored ? t("unfetchableMessages.restore") : t("unfetchableMessages.ignore")}
          </Button>
        </div>
      ))}
    </div>
  );
}
