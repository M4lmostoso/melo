import { ArrowRightLeft } from "lucide-react";
import { t } from "@/i18n";
import { useTransferStore } from "@/stores/transferStore";

/**
 * Mounted once in App — shows the cross-account move progress while a transfer
 * is running. Sits above the toast stack (bottom-right) and disappears on its
 * own when the move finishes; the outcome is reported by a toast.
 */
export function TransferProgressHost() {
  const progress = useTransferStore((s) => s.progress);
  if (!progress) return null;

  const { done, total, target, currentSubject } = progress;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div
      className="glass-panel rounded-lg border border-border-primary shadow-lg px-3 py-2.5 w-72"
      role="status"
      aria-live="polite"
    >
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
