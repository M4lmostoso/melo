import { invoke } from "@tauri-apps/api/core";
import { createBackgroundChecker } from "../backgroundCheckers";
import { getSetting, setSetting } from "./settings";
import { getCurrentUnixTimestamp } from "@/utils/timestamp";

export interface DbStats {
  file_size_bytes: number;
  page_count: number;
  page_size: number;
  freelist_count: number;
  freelist_bytes: number;
}

export interface DbVacuumResult {
  file_size_before_bytes: number;
  file_size_after_bytes: number;
}

const LAST_OPTIMIZE_KEY = "db_maintenance_last_optimize_at";
const LAST_VACUUM_KEY = "db_maintenance_last_vacuum_at";
const OPTIMIZE_EVERY_SECONDS = 24 * 60 * 60; // once a day is plenty for PRAGMA optimize

export async function getDbStats(): Promise<DbStats> {
  return invoke<DbStats>("db_get_stats");
}

/** Cheap, safe to run anytime — refreshes the query planner's statistics. */
export async function runDbOptimize(): Promise<void> {
  await invoke("db_run_optimize");
  await setSetting(LAST_OPTIMIZE_KEY, String(getCurrentUnixTimestamp()));
}

/**
 * Rebuilds the DB file to reclaim disk space. Holds a write lock for the
 * duration and needs headroom on disk, so this is only ever called from an
 * explicit user action in Settings — never from the background checker.
 */
export async function runDbVacuum(): Promise<DbVacuumResult> {
  const result = await invoke<DbVacuumResult>("db_run_vacuum");
  const now = String(getCurrentUnixTimestamp());
  await setSetting(LAST_VACUUM_KEY, now);
  await setSetting(LAST_OPTIMIZE_KEY, now);
  return result;
}

export async function getLastOptimizeAt(): Promise<number | null> {
  const value = await getSetting(LAST_OPTIMIZE_KEY);
  return value ? Number(value) : null;
}

export async function getLastVacuumAt(): Promise<number | null> {
  const value = await getSetting(LAST_VACUUM_KEY);
  return value ? Number(value) : null;
}

/**
 * Runs `PRAGMA optimize` at most once a day. Checked every hour rather than
 * scheduled once at startup so a long-running session still gets refreshed
 * planner stats without depending on a restart.
 */
async function checkOptimizeDue(): Promise<void> {
  const lastRun = await getLastOptimizeAt();
  const now = getCurrentUnixTimestamp();
  if (lastRun && now - lastRun < OPTIMIZE_EVERY_SECONDS) return;
  await runDbOptimize();
}

const dbMaintenanceChecker = createBackgroundChecker(
  "DbMaintenance",
  checkOptimizeDue,
  60 * 60 * 1000, // check hourly; actual optimize is throttled to once/day above
);
export const startDbMaintenanceChecker = dbMaintenanceChecker.start;
export const stopDbMaintenanceChecker = dbMaintenanceChecker.stop;
