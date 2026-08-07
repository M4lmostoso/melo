import { ArrowRightLeft } from "lucide-react";
import { t } from "@/i18n";
import { useTransferStore, type TransferProgress } from "@/stores/transferStore";

/** How many transfers get their own row before the rest collapse into a summary. */
const MAX_VISIBLE = 5;

function TransferRow({ transfer }: { transfer: TransferProgress }) {
  const { done, total, target, currentSubject } = transfer;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="px-3 py-2 border-b border-border-primary/60 last:border-b-0">
      <div className="flex items-center gap-2">
        <ArrowRightLeft size={14} className="shrink-0 text-accent animate-pulse" />
        <span className="text-xs font-medium text-text-primary flex-1 truncate">
          {t("ui.transfer.title", { target })}
        </span>
        <span className="text-xs text-text-tertiary tabular-nums">
          {t("ui.transfer.count", { done, total })}
        </span>
      </div>
      <div className="mt-2 h-1 rounded-full bg-bg-hover overflow-hidden">
        <div
          className="h-full bg-accent transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      {currentSubject && (
        <div className="mt-1.5 text-[11px] text-text-tertiary truncate">{currentSubject}</div>
      )}
    </div>
  );
}

/**
 * Mounted once in App (inside ToastHost's column) — shows every cross-account
 * move that is currently running, oldest first. Beyond MAX_VISIBLE the extra
 * transfers collapse into one summary line: queueing a dozen threads must still
 * tell the user how much is left instead of hiding everything but one row.
 */
export function TransferProgressHost() {
  const transfers = useTransferStore((s) => s.transfers);
  if (transfers.length === 0) return null;

  const visible = transfers.slice(0, MAX_VISIBLE);
  const hidden = transfers.slice(MAX_VISIBLE);
  const hiddenDone = hidden.reduce((sum, tr) => sum + tr.done, 0);
  const hiddenTotal = hidden.reduce((sum, tr) => sum + tr.total, 0);

  return (
    <div
      className="glass-panel rounded-lg border border-border-primary shadow-lg w-72 overflow-hidden"
      role="status"
      aria-live="polite"
    >
      {transfers.length > 1 && (
        <div className="px-3 pt-2 pb-1 text-[11px] font-medium text-text-secondary">
          {t("ui.transfer.activeCount", { count: transfers.length })}
        </div>
      )}
      {visible.map((transfer) => (
        <TransferRow key={transfer.id} transfer={transfer} />
      ))}
      {hidden.length > 0 && (
        <div className="px-3 py-2 text-[11px] text-text-tertiary border-t border-border-primary/60">
          {t("ui.transfer.more", {
            count: hidden.length,
            done: hiddenDone,
            total: hiddenTotal,
          })}
        </div>
      )}
    </div>
  );
}
