import { escapeHtml, sanitizeHtml } from "@/utils/sanitize";
import { restoreRemoteImages } from "@/utils/imageBlocker";
import { formatAddress } from "@/utils/emailUtils";
import { t } from "@/i18n";

/**
 * Minimal shape a quoted message needs. Accepts both `DbMessage` rows and the
 * lighter objects the context menu builds from thread data.
 */
export interface QuotableMessage {
  from_name: string | null;
  from_address: string | null;
  date: string | number;
  subject?: string | null;
  to_addresses?: string | null;
  body_html: string | null;
  body_text: string | null;
}

/**
 * Sender label for the attribution line, HTML-escaped.
 *
 * Goes through {@link formatAddress}, so a display name with an unquoted comma
 * ("Melki, Benjamin") is quoted: without that, the outgoing line read
 * `On 23/09/2026, 10:28, Melki, Benjamin <b@x> wrote:` — four comma-separated
 * fragments that no reader (and no attribution regex) can tell apart.
 */
function quoteSender(msg: QuotableMessage): string {
  const email = msg.from_address ?? "";
  if (!email) return escapeHtml(msg.from_name ?? "Unknown");
  return escapeHtml(formatAddress({ name: msg.from_name ?? null, email }));
}

const QUOTE_STYLE =
  "border-left:2px solid #ccc;padding-left:12px;margin-left:0;color:#666;margin-bottom:8px";

/**
 * Reply quote: ONLY the message being replied to, in a quoted block introduced
 * by a localized attribution line. Its body already carries the earlier history,
 * so quoting the rest of the thread too re-quoted every message N times — the
 * chain doubled at each reply and a ~13-message thread reached 253 attributions
 * and 11.6 MB, which Exchange refused to send.
 */
export function buildReplyQuote(msg: QuotableMessage | undefined): string {
  if (!msg) return "";
  const date = new Date(msg.date).toLocaleString();
  const body = msg.body_html ? sanitizeHtml(msg.body_html) : escapeHtml(msg.body_text ?? "");
  const attribution = escapeHtml(t("composer.quote.attribution", { date }))
    .replace("{sender}", quoteSender(msg));
  return `<br><br><div style="${QUOTE_STYLE}">${attribution}<br>${body}</div>`;
}

/**
 * Forward quote: original headers (localized labels) above each body, newest
 * message first. Remote images are restored so the forwarded copy renders.
 */
export function buildForwardQuote(msgs: QuotableMessage[], opts?: { restoreImages?: boolean }): string {
  if (msgs.length === 0) return "";
  // Callers pass the thread in chronological order, ending with the message
  // being forwarded — that one must open the quote, not the oldest in the chain.
  const parts = [...msgs].reverse().map((msg) => {
    const date = new Date(msg.date).toLocaleString();
    const rawHtml = msg.body_html
      ? opts?.restoreImages
        ? restoreRemoteImages(msg.body_html)
        : msg.body_html
      : null;
    const body = rawHtml ? sanitizeHtml(rawHtml) : escapeHtml(msg.body_text ?? "");
    const headers = [
      `${escapeHtml(t("composer.quote.from"))} ${quoteSender(msg)}`,
      `${escapeHtml(t("composer.quote.date"))} ${escapeHtml(date)}`,
      `${escapeHtml(t("composer.quote.subject"))} ${escapeHtml(msg.subject ?? "")}`,
      `${escapeHtml(t("composer.quote.to"))} ${escapeHtml(msg.to_addresses ?? "")}`,
    ].join("<br>");
    return `${headers}<br><br>${body}`;
  });
  const fwd = escapeHtml(t("composer.quote.forwardedHeader"));
  const prev = escapeHtml(t("composer.quote.previousHeader"));
  return `<br><br>${fwd}<br><br>${parts.join(`<br><br>${prev}<br><br>`)}`;
}
