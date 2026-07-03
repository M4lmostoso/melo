import {
  getPendingScheduledEmails,
  updateScheduledEmailStatus,
} from "../db/scheduledEmails";
import { buildRawEmail, type EmailAttachment } from "@/utils/emailBuilder";
import { getAccount } from "../db/accounts";
import { createBackgroundChecker } from "../backgroundCheckers";
import { sendEmail } from "../emailActions";
import { useOutgoingStore } from "@/stores/outgoingStore";
import { t } from "@/i18n";

function notifyScheduledFailed(subject: string | null): void {
  import("@tauri-apps/plugin-notification")
    .then(({ sendNotification }) => {
      sendNotification({
        title: t("outgoing.scheduledFailedTitle"),
        body: t("outgoing.scheduledFailedBody", { subject: subject ?? "" }),
      });
    })
    .catch(() => {});
  window.dispatchEvent(new Event("melo-sync-done"));
}

/**
 * Check for scheduled emails that are ready to be sent.
 */
async function checkScheduledEmails(): Promise<void> {
  const pending = await getPendingScheduledEmails();

  for (const email of pending) {
    try {
      const account = await getAccount(email.account_id);
      if (!account) {
        await updateScheduledEmailStatus(email.id, "failed");
        continue;
      }

      // Mark as "sending" BEFORE attempting send to prevent duplicate sends
      await updateScheduledEmailStatus(email.id, "sending");

      // Parse attachments from JSON if present. A parse failure must NOT send the
      // email stripped of its attachments — mark it failed and tell the user instead.
      let attachments: EmailAttachment[] | undefined;
      if (email.attachment_paths) {
        try {
          attachments = JSON.parse(email.attachment_paths) as EmailAttachment[];
        } catch {
          console.error(`Failed to parse attachment_paths for scheduled email ${email.id} — not sending without attachments`);
          await updateScheduledEmailStatus(email.id, "failed");
          notifyScheduledFailed(email.subject);
          continue;
        }
      }

      const toList = email.to_addresses.split(",").map((a) => a.trim());
      const ccList = email.cc_addresses
        ? email.cc_addresses.split(",").map((a) => a.trim())
        : [];
      const bccList = email.bcc_addresses
        ? email.bcc_addresses.split(",").map((a) => a.trim())
        : [];

      const raw = buildRawEmail({
        from: account.email,
        to: toList,
        cc: ccList.length > 0 ? ccList : undefined,
        bcc: bccList.length > 0 ? bccList : undefined,
        subject: email.subject ?? "",
        htmlBody: email.body_html,
        threadId: email.thread_id ?? undefined,
        attachments,
      });

      // Surface the scheduled email in Outgoing only now, at fire time — it stays there
      // for the few seconds of the real SMTP+APPEND, then disappears (→ Sent). Routing
      // through sendEmail (not provider.sendMessage directly) means that if we're offline
      // the send is queued to pending_operations, so it remains visible in Outgoing and
      // is retried automatically instead of vanishing.
      const outgoingId = `scheduled-${email.id}`;
      useOutgoingStore.getState().addEmail({
        id: outgoingId,
        accountId: email.account_id,
        to: toList,
        cc: ccList,
        bcc: bccList,
        subject: email.subject ?? "",
        bodyHtml: email.body_html,
        threadId: email.thread_id ?? null,
        inReplyToMessageId: null,
        raw,
        status: "sending",
        createdAt: Date.now(),
        timerId: null,
      });

      try {
        const result = await sendEmail(email.account_id, raw, email.thread_id ?? undefined);
        if (!result.success) {
          throw new Error(result.error ?? "Scheduled send failed");
        }
        // Sent or handed to the offline queue (queued) — either way the scheduled row is done.
        await updateScheduledEmailStatus(email.id, "sent");
      } finally {
        useOutgoingStore.getState().removeEmail(outgoingId);
      }
    } catch (err) {
      console.error(`Failed to send scheduled email ${email.id}:`, err);
      // Distinguish transient vs permanent errors
      const message = err instanceof Error ? err.message : String(err);
      const isTransient = message.includes("5") && /\b5\d{2}\b/.test(message)
        || message.toLowerCase().includes("network")
        || message.toLowerCase().includes("timeout")
        || message.toLowerCase().includes("econnrefused");
      // Revert to pending for transient errors (allows retry), mark failed for permanent
      await updateScheduledEmailStatus(email.id, isTransient ? "pending" : "failed");
      if (!isTransient) notifyScheduledFailed(email.subject);
    }
  }
}

const scheduledSendChecker = createBackgroundChecker("ScheduledSend", checkScheduledEmails);
export const startScheduledSendChecker = scheduledSendChecker.start;
export const stopScheduledSendChecker = scheduledSendChecker.stop;
