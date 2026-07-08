import { useEffect, useState, useCallback } from "react";
import { DatabaseZap, HardDrive } from "lucide-react";
import { Section } from "./shared";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { t } from "@/i18n";
import { formatFileSize } from "@/utils/fileTypeHelpers";
import {
  getDbStats,
  runDbVacuum,
  getLastOptimizeAt,
  getLastVacuumAt,
  type DbStats,
} from "@/services/db/maintenance";

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-text-secondary">{label}</span>
      <span className="text-sm text-text-primary font-mono">{value}</span>
    </div>
  );
}

function formatTimestamp(unixSeconds: number | null): string {
  if (!unixSeconds) return t("settings.database.never");
  return new Date(unixSeconds * 1000).toLocaleString();
}

export function DatabaseTab() {
  const [stats, setStats] = useState<DbStats | null>(null);
  const [lastOptimizeAt, setLastOptimizeAt] = useState<number | null>(null);
  const [lastVacuumAt, setLastVacuumAt] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [freedBytes, setFreedBytes] = useState<number | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, opt, vac] = await Promise.all([
        getDbStats(),
        getLastOptimizeAt(),
        getLastVacuumAt(),
      ]);
      setStats(s);
      setLastOptimizeAt(opt);
      setLastVacuumAt(vac);
      setLoadError(null);
    } catch (err) {
      setLoadError(String(err));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleVacuum = async () => {
    setConfirmOpen(false);
    setRunning(true);
    setRunError(null);
    setFreedBytes(null);
    try {
      const result = await runDbVacuum();
      setFreedBytes(Math.max(0, result.file_size_before_bytes - result.file_size_after_bytes));
      await load();
    } catch (err) {
      setRunError(String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <Section title={t("settings.database.sections.diskUsage")}>
        {loadError ? (
          <p className="text-xs text-danger">{loadError}</p>
        ) : (
          <>
            <InfoRow
              label={t("settings.database.fileSize")}
              value={stats ? formatFileSize(stats.file_size_bytes) : "..."}
            />
            <InfoRow
              label={t("settings.database.reclaimableSpace")}
              value={stats ? formatFileSize(stats.freelist_bytes) : "..."}
            />
            <InfoRow
              label={t("settings.database.pageCount")}
              value={stats ? stats.page_count.toLocaleString() : "..."}
            />
          </>
        )}
      </Section>

      <Section
        title={t("settings.database.sections.autoMaintenance")}
        description={t("settings.database.autoMaintenanceDesc")}
      >
        <InfoRow
          label={t("settings.database.lastOptimize")}
          value={formatTimestamp(lastOptimizeAt)}
        />
      </Section>

      <Section
        title={t("settings.database.sections.compact")}
        description={t("settings.database.compactDesc")}
      >
        <InfoRow label={t("settings.database.lastVacuum")} value={formatTimestamp(lastVacuumAt)} />

        {freedBytes !== null && (
          <p className="text-xs text-success">
            {t("settings.database.vacuumSuccess", { size: formatFileSize(freedBytes) })}
          </p>
        )}
        {runError && <p className="text-xs text-danger">{runError}</p>}

        <div className="pt-1">
          <Button
            variant="secondary"
            size="md"
            icon={<DatabaseZap size={14} className={running ? "animate-pulse" : ""} />}
            onClick={() => setConfirmOpen(true)}
            disabled={running}
            className="bg-bg-tertiary text-text-primary border border-border-primary"
          >
            {running ? t("settings.database.compacting") : t("settings.database.compactNow")}
          </Button>
        </div>
      </Section>

      <ConfirmDialog
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={handleVacuum}
        title={t("settings.database.compactConfirmTitle")}
        message={
          <div className="flex items-start gap-2">
            <HardDrive size={16} className="text-text-tertiary shrink-0 mt-0.5" />
            <span>{t("settings.database.compactConfirmMessage")}</span>
          </div>
        }
        confirmLabel={t("settings.database.compactNow")}
      />
    </>
  );
}
