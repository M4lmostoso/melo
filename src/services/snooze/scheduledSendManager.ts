import {
  getPendingScheduledEmails,
  handOffScheduledToOutgoing,
  updateScheduledEmailStatus,
  type DbScheduledEmail,
} from "../db/scheduledEmails";
import {
  deleteOperation,
  patchOperationParams,
  updateOperationStatus,
} from "../db/pendingOperations";
import { buildRawEmail, type EmailAttachment } from "@/utils/emailBuilder";
import { getAccount } from "../db/accounts";
import { createBackgroundChecker } from "../backgroundCheckers";
import { sendEmail } from "../emailActions";
import { useOutgoingStore } from "@/stores/outgoingStore";
import { useToastStore } from "@/stores/toastStore";
import { playSound } from "../soundService";
import { t } from "@/i18n";
import { splitAddressList } from "@/utils/emailUtils";

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

function notifyOutgoingFailure(title: string, body: string): void {
  useToastStore.getState().showToast("error", body);
  void playSound("send_error");
  import("@tauri-apps/plugin-notification")
    .then(({ sendNotification }) => sendNotification({ title, body }))
    .catch(() => {});
}

/**
 * Check for scheduled emails that are ready to be sent.
 */
async function checkScheduledEmails(): Promise<void> {
  const pending = await getPendingScheduledEmails();

  for (const email of pending) {
    let opId: string | null = null;
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

      const toList = splitAddressList(email.to_addresses);
      const ccList = splitAddressList(email.cc_addresses);
      const bccList = splitAddressList(email.bcc_addresses);

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

      // Fire time: the email leaves Scheduled and becomes an Outgoing send. The
      // pending_operations row (raw inside) is written in the same transaction that
      // closes the scheduled row, so whatever happens next — refused, unconfirmed,
      // app killed mid-send — the email sits in Outgoing where the failure is
      // obvious, instead of reverting to a 'failed' row hidden in Scheduled.
      const threadId = email.thread_id ?? undefined;
      opId = await handOffScheduledToOutgoing(
        email.id,
        email.account_id,
        email.thread_id ?? crypto.randomUUID(),
        { rawBase64Url: raw, threadId },
      );

      // While the SMTP+APPEND runs the DB row is 'executing' (not counted by
      // Outgoing), so the in-memory entry is what shows it as "sending".
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
        await settleOutgoingSend(opId, email, raw, threadId);
      } finally {
        useOutgoingStore.getState().removeEmail(outgoingId);
        window.dispatchEvent(new Event("melo-sync-done"));
      }
    } catch (err) {
      console.error(`Failed to send scheduled email ${email.id}:`, err);
      if (opId) {
        // Already in Outgoing: never revive the scheduled row (duplicate send risk).
        // If even this write fails the row stays 'executing' and startup recovery
        // flags it as an interrupted send.
        await updateOperationStatus(opId, "failed", t("outgoing.interruptedBody")).catch(() => {});
        notifyOutgoingFailure(
          t("outgoing.scheduledFailedTitle"),
          t("outgoing.scheduledInOutgoingBody", { subject: email.subject ?? "" }),
        );
        window.dispatchEvent(new Event("melo-sync-done"));
      } else {
        // Before the hand-off there is no raw yet — the scheduled row is the only
        // copy, so it stays in Scheduled as 'failed' with a Retry.
        await updateScheduledEmailStatus(email.id, "failed").catch(() => {});
        notifyScheduledFailed(email.subject);
      }
    }
  }
}

/**
 * Send the handed-off email and leave its Outgoing row in the state that matches
 * the outcome — the same rules as an interactive send (App.tsx melo-execute-send).
 */
async function settleOutgoingSend(
  opId: string,
  email: DbScheduledEmail,
  raw: string,
  threadId: string | undefined,
): Promise<void> {
  let result: Awaited<ReturnType<typeof sendEmail>>;
  try {
    result = await sendEmail(email.account_id, raw, threadId);
  } catch (err) {
    result = { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (!result.success) {
    await updateOperationStatus(opId, "failed", result.error ?? undefined);
    notifyOutgoingFailure(
      t("outgoing.scheduledFailedTitle"),
      result.error
        ? t("outgoing.scheduledInOutgoingBodyWithError", { subject: email.subject ?? "", error: result.error })
        : t("outgoing.scheduledInOutgoingBody", { subject: email.subject ?? "" }),
    );
    return;
  }

  if (result.queued) {
    // executeEmailAction queued its own retryable op (offline / transient error);
    // that row now carries the email in Outgoing, ours would be a duplicate.
    await deleteOperation(opId);
    return;
  }

  if (result.sendUnconfirmed) {
    // Deliberately NOT deliveredNoCopy: that would rule out an actual re-send.
    await updateOperationStatus(opId, "failed", t("outgoing.sendUnconfirmedBody"));
    notifyOutgoingFailure(t("outgoing.sendUnconfirmedTitle"), t("outgoing.sendUnconfirmedBody"));
    return;
  }

  if (result.sentCopyDurable === false) {
    // Delivered, but this row is the last copy — a retry must file it, not re-send.
    await patchOperationParams(opId, { deliveredNoCopy: true });
    await updateOperationStatus(opId, "failed", t("outgoing.sentCopyMissingBody"));
    notifyOutgoingFailure(t("outgoing.sentCopyMissingTitle"), t("outgoing.sentCopyMissingBody"));
    return;
  }

  await deleteOperation(opId);
}

const scheduledSendChecker = createBackgroundChecker("ScheduledSend", checkScheduledEmails);
export const startScheduledSendChecker = scheduledSendChecker.start;
export const stopScheduledSendChecker = scheduledSendChecker.stop;
