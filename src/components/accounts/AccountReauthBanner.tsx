import { useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useUIStore } from "@/stores/uiStore";
import { useAccountStore } from "@/stores/accountStore";
import { reauthorizeAccount } from "@/services/gmail/tokenManager";
import { triggerSync } from "@/services/gmail/syncManager";
import { t } from "@/i18n";

/**
 * Prominent banner shown when an account's OAuth refresh token was rejected
 * (invalid_grant). Mail sync is dead for that account until re-authorized —
 * mirrors CalendarReauthBanner but for the mail path, where the only previous
 * signal was a tiny error icon in the sidebar.
 */
export function AccountReauthBanner() {
  const accountSyncStatuses = useUIStore((s) => s.accountSyncStatuses);
  const setAccountSyncHealth = useUIStore((s) => s.setAccountSyncHealth);
  const accounts = useAccountStore((s) => s.accounts);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const needing = accounts.filter(
    (a) => a.isActive && accountSyncStatuses[a.id]?.needsReauth,
  );
  if (needing.length === 0) return null;

  const account = needing[0]!;

  const handleReauthorize = async () => {
    setBusyId(account.id);
    setError(null);
    try {
      await reauthorizeAccount(account.id, account.email);
      setAccountSyncHealth(account.id, { needsReauth: false });
      triggerSync([account.id]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="fixed top-8 left-1/2 -translate-x-1/2 z-50 max-w-xl w-[calc(100%-2rem)] p-3 rounded-lg bg-warning/95 text-white shadow-lg backdrop-blur-sm flex items-start gap-2.5">
      <AlertTriangle size={16} className="shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{t("account.reauthBannerTitle")}</p>
        <p className="text-xs opacity-90 mt-0.5">
          {t("account.reauthBannerDesc", { email: account.email })}
        </p>
        {error && <p className="text-xs mt-1 font-medium">{error}</p>}
      </div>
      <button
        onClick={handleReauthorize}
        disabled={busyId !== null}
        className="shrink-0 px-3 py-1.5 text-xs font-medium bg-white/20 hover:bg-white/30 rounded-md transition-colors disabled:opacity-50 flex items-center gap-1.5"
      >
        {busyId && <Loader2 size={12} className="animate-spin" />}
        {busyId ? t("account.reauthWaiting") : t("account.reauthButton")}
      </button>
    </div>
  );
}
