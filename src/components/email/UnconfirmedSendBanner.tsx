import { AlertTriangle } from "lucide-react";
import { t } from "@/i18n";

/**
 * Shown on a sent message whose delivery the server never confirmed.
 *
 * A positive SMTP reply is not proof the mail left: the relay can accept the
 * transaction and refuse the message behind it. When that happened the copy was
 * still written to the local Sent folder, indistinguishable from a delivered
 * email — so a mail the server had in fact refused looked perfectly sent for
 * hours. This banner is the difference between "sent" and "we cannot tell".
 */
export function UnconfirmedSendBanner() {
  return (
    <div
      role="alert"
      className="bg-warning/10 border border-warning/30 rounded-lg p-3 mb-3 flex items-start gap-2"
    >
      <AlertTriangle size={16} className="text-warning shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-warning font-medium">
          {t("email.unconfirmedSend.title")}
        </p>
        <p className="text-xs text-text-secondary mt-0.5">
          {t("email.unconfirmedSend.description")}
        </p>
      </div>
    </div>
  );
}

/** Compact marker for the collapsed message header, where the banner has no room. */
export function UnconfirmedSendBadge() {
  return (
    <span
      title={t("email.unconfirmedSend.description")}
      className="inline-flex items-center gap-1 shrink-0 px-1.5 py-0.5 rounded bg-warning/15 text-warning text-[10px] font-medium align-middle"
    >
      <AlertTriangle size={10} />
      {t("email.unconfirmedSend.badge")}
    </span>
  );
}
