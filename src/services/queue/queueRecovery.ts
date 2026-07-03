import { getDb } from "../db/connection";
import { t } from "@/i18n";

/**
 * Startup recovery for operations interrupted by a crash / app quit.
 *
 * Both 'executing' (pending_operations) and 'sending' (scheduled_emails) are set
 * only by in-process code, so at startup any row still in those states was
 * interrupted mid-flight and would otherwise be stuck invisible forever — the
 * pollers only select 'pending' rows.
 *
 * Sends are NOT auto-retried: the interruption may have happened after the SMTP
 * server accepted the message but before the row was deleted, so a blind replay
 * risks a duplicate delivery. They are marked 'failed' (visible in Outgoing with
 * a Retry button) and the user is actively notified. Idempotent ops (markRead,
 * star, label, move, …) are safely re-queued.
 *
 * Rows in status 'undo' are promoted to 'pending': the user pressed Send and the
 * app died before the undo window elapsed — after a restart the undo window is
 * moot and the email must go out.
 */
export async function recoverInterruptedOperations(): Promise<void> {
  const db = await getDb();

  // Interrupted sends → failed + notify (duplicate risk forbids auto-resend).
  const interruptedSends = await db.execute(
    `UPDATE pending_operations
     SET status = 'failed', error_message = $1
     WHERE status = 'executing' AND operation_type = 'sendMessage'`,
    [t("outgoing.interruptedBody")],
  );

  // Interrupted idempotent ops → safe to re-queue.
  await db.execute(
    `UPDATE pending_operations
     SET status = 'pending', next_retry_at = NULL
     WHERE status = 'executing' AND operation_type != 'sendMessage'`,
  );

  // Sends still inside their undo window when the app died → send now.
  const promotedUndo = await db.execute(
    `UPDATE pending_operations
     SET status = 'pending', next_retry_at = NULL
     WHERE status = 'undo'`,
  );

  // Scheduled emails stuck in 'sending' → failed + notify (same duplicate risk).
  const interruptedScheduled = await db.execute(
    `UPDATE scheduled_emails SET status = 'failed' WHERE status = 'sending'`,
  );

  if (promotedUndo.rowsAffected > 0) {
    console.log(
      `[queueRecovery] Promoted ${promotedUndo.rowsAffected} undo-window send(s) interrupted by restart`,
    );
  }

  if (interruptedSends.rowsAffected > 0 || interruptedScheduled.rowsAffected > 0) {
    console.warn(
      `[queueRecovery] Flagged interrupted sends: ${interruptedSends.rowsAffected} outgoing, ${interruptedScheduled.rowsAffected} scheduled`,
    );
    import("@tauri-apps/plugin-notification")
      .then(({ sendNotification }) => {
        sendNotification({
          title: t("outgoing.interruptedTitle"),
          body: t("outgoing.interruptedBody"),
        });
      })
      .catch(() => {});
    window.dispatchEvent(new Event("melo-sync-done"));
  }
}
