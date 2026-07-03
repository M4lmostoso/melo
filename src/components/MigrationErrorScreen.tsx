import { useState } from "react";
import { AlertTriangle, Copy, RotateCcw, Check } from "lucide-react";
import { t } from "@/i18n";

/**
 * Blocking screen shown when database migrations fail at startup. Booting the
 * main UI on a partially migrated schema would surface as random runtime SQL
 * errors and possible data corruption — better to stop, explain, and let the
 * user retry or report with the exact error.
 */
export function MigrationErrorScreen({ error }: { error: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(error);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable — nothing else to do
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-bg-primary px-6">
      <div className="max-w-lg w-full flex flex-col items-center text-center gap-4">
        <div className="w-12 h-12 rounded-full bg-danger/10 flex items-center justify-center">
          <AlertTriangle size={24} className="text-danger" />
        </div>
        <h1 className="text-lg font-semibold text-text-primary">
          {t("errors.migrationFailedTitle")}
        </h1>
        <p className="text-sm text-text-secondary">
          {t("errors.migrationFailedBody")}
        </p>
        <pre className="w-full max-h-40 overflow-auto text-left text-xs bg-bg-secondary border border-border-primary rounded-md p-3 text-text-secondary whitespace-pre-wrap break-all">
          {error}
        </pre>
        <div className="flex gap-2">
          <button
            onClick={handleCopy}
            className="px-3 py-1.5 text-xs font-medium bg-bg-tertiary border border-border-primary rounded-md text-text-primary hover:bg-bg-hover transition-colors flex items-center gap-1.5"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? t("errors.migrationCopied") : t("errors.migrationCopyDetails")}
          </button>
          <button
            onClick={() => window.location.reload()}
            className="px-3 py-1.5 text-xs font-medium bg-accent text-white rounded-md hover:bg-accent-hover transition-colors flex items-center gap-1.5"
          >
            <RotateCcw size={12} />
            {t("errors.migrationRetry")}
          </button>
        </div>
        <p className="text-xs text-text-tertiary">
          {t("errors.migrationBackupHint")}
        </p>
      </div>
    </div>
  );
}
