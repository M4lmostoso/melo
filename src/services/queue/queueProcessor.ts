import { createBackgroundChecker, type BackgroundChecker } from "../backgroundCheckers";
import { useUIStore } from "@/stores/uiStore";
import {
  getPendingOperations,
  updateOperationStatus,
  deleteOperation,
  incrementRetry,
  getPendingOpsCount,
  compactQueue,
  promoteExpiredUndoOperations,
} from "../db/pendingOperations";
import { executeQueuedAction } from "../emailActions";
import { classifyError } from "@/utils/networkErrors";
import { t } from "@/i18n";

const BATCH_SIZE = 50;

let checker: BackgroundChecker | null = null;

/**
 * Actively notify the user that an operation will never be retried again.
 * Without this the only trace of e.g. a permanently failed send is the passive
 * Outgoing badge — a user who saw "will be retried automatically" would keep
 * believing the email went out.
 */
function notifyOperationFailed(operationType: string, errorMessage?: string): void {
  const isSend = operationType === "sendMessage";
  import("@tauri-apps/plugin-notification")
    .then(({ sendNotification }) => {
      sendNotification({
        title: isSend ? t("outgoing.sendFailedTitle") : t("outgoing.opFailedTitle"),
        body: isSend
          ? errorMessage
            ? t("outgoing.sendFailedBodyWithError", { error: errorMessage })
            : t("outgoing.sendFailedBody")
          : t("outgoing.opFailedBody", { operation: operationType }),
      });
    })
    .catch(() => {});
  if (isSend) {
    import("../soundService").then(({ playSound }) => void playSound("send_error")).catch(() => {});
  }
  window.dispatchEvent(new Event("melo-sync-done"));
}

async function processQueue(): Promise<void> {
  // Skip if offline
  if (!useUIStore.getState().isOnline) return;

  // Promote undo-window sends whose composer died before the timer fired.
  // Normally a no-op: the live composer claims its row (CAS) well before the
  // deadline+grace stored in next_retry_at.
  await promoteExpiredUndoOperations();

  // Compact first to eliminate redundant ops
  await compactQueue();

  // Get pending operations
  const ops = await getPendingOperations(undefined, BATCH_SIZE);
  if (ops.length === 0) {
    await updatePendingCount();
    return;
  }

  for (const op of ops) {
    try {
      // Mark as executing
      await updateOperationStatus(op.id, "executing");

      // Parse params and execute
      const params = JSON.parse(op.params) as Record<string, unknown>;
      await executeQueuedAction(op.account_id, op.operation_type, params);

      // Success — delete from queue
      await deleteOperation(op.id);
    } catch (err) {
      const classified = classifyError(err);

      if (classified.isRetryable) {
        // Increment retry with exponential backoff
        await updateOperationStatus(op.id, "pending", classified.message);
        const outcome = await incrementRetry(op.id);
        if (outcome === "failed") notifyOperationFailed(op.operation_type, classified.message);
        if (classified.type === "network") {
          // "Online" but network calls fail → probe for captive portal / dead link.
          import("../connectivityMonitor")
            .then(({ reportNetworkFailure }) => reportNetworkFailure())
            .catch(() => {});
        }
      } else {
        // Permanent failure
        await updateOperationStatus(op.id, "failed", classified.message);
        notifyOperationFailed(op.operation_type, classified.message);
      }
    }
  }

  await updatePendingCount();
}

async function updatePendingCount(): Promise<void> {
  const count = await getPendingOpsCount();
  useUIStore.getState().setPendingOpsCount(count);
}

export function startQueueProcessor(): void {
  if (checker) return;
  checker = createBackgroundChecker("QueueProcessor", processQueue, 30_000);
  checker.start();
}

export function stopQueueProcessor(): void {
  checker?.stop();
  checker = null;
}

/**
 * Trigger an immediate queue flush (e.g., when coming back online).
 * Returns a promise that resolves when processing completes.
 */
export async function triggerQueueFlush(): Promise<void> {
  try {
    await processQueue();
  } catch (err) {
    console.error("[QueueProcessor] flush failed:", err);
  }
}
