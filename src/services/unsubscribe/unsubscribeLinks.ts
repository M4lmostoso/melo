import { t } from "@/i18n";
import { normalizeEmail } from "@/utils/emailUtils";

// Pure opt-out link helpers — no Tauri imports, so the reading pane can use
// them synchronously while unsubscribeManager stays lazily loaded.

/**
 * Link texts (and URL fragments) that mark an opt-out link in a mail body.
 * Strong matches are real unsubscribe links; weak ones are preference centres,
 * used only when nothing stronger is on the page.
 */
const STRONG_UNSUBSCRIBE_RE =
  /unsubscri|opt[\s_-]?out|disiscri|cancella(?:re)?\s+(?:l['’]\s*)?iscrizione|annulla(?:re)?\s+(?:l['’]\s*)?iscrizione|non\s+ricevere\s+più|abmelden|abbestellen|désabonn|desabonn|désinscri|darse\s+de\s+baja|cancelar\s+(?:la\s+)?suscripci/i;
/** Cheap gate on the raw HTML: no keyword anywhere → skip the DOM parse. */
const UNSUBSCRIBE_HINT_RE =
  /unsubscri|opt[\s_-]?out|disiscri|iscrizione|ricevere|abmeld|abbestell|sabonn|sinscri|baja|suscripci|preferen|subscription/i;
const WEAK_UNSUBSCRIBE_RE =
  /(?:manage|update|email|e-mail)\s+(?:your\s+)?(?:email\s+)?(?:preferences|subscriptions?)|gestisci\s+(?:le\s+)?(?:tue\s+)?(?:preferenze|iscrizion)|preferenze\s+(?:e-?mail|di\s+iscrizione)/i;

/**
 * Find the opt-out link in an HTML mail body: the footer "unsubscribe" link a
 * sender without a List-Unsubscribe header still has to carry.
 *
 * Only http(s) links are returned, and the caller only ever *opens* them in the
 * browser — never fetches them — so a mis-detected link costs one wrong page,
 * not a silent request on the user's behalf. Links inside quoted text are
 * skipped: a reply quoting a newsletter must not offer the newsletter's
 * opt-out. `strongOnly` drops the preference-centre fallback, for contexts
 * (the reading pane) where the sender is not already known to be a list.
 */
export function findUnsubscribeLinkInHtml(
  html: string,
  { strongOnly = false }: { strongOnly?: boolean } = {},
): string | null {
  if (!UNSUBSCRIBE_HINT_RE.test(html)) return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  let weak: string | null = null;
  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    const href = a.getAttribute("href")?.trim() ?? "";
    if (!/^https?:\/\//i.test(href)) continue;
    if (a.closest("blockquote, .gmail_quote")) continue;
    const label = `${a.textContent ?? ""} ${a.getAttribute("title") ?? ""}`.replace(/\s+/g, " ");
    if (STRONG_UNSUBSCRIBE_RE.test(label)) return href;
    if (!strongOnly && !weak && (WEAK_UNSUBSCRIBE_RE.test(label) || STRONG_UNSUBSCRIBE_RE.test(href))) {
      weak = href;
    }
  }
  return weak;
}

/** The message fields needed to unsubscribe from a thread's sender. */
export interface UnsubscribableMessage {
  from_address: string | null;
  from_name: string | null;
  list_unsubscribe: string | null;
  list_unsubscribe_post: string | null;
  body_html: string | null;
  is_draft?: number | null;
}

/**
 * Pick what a thread can be unsubscribed through: the first message carrying
 * a List-Unsubscribe header, else the newest non-own message whose body has a
 * clear opt-out link (`bodyLink`). Null when the thread offers neither.
 *
 * Never a body link for spam: "unsubscribing" from spam only confirms to the
 * sender that the address is alive — and those were most of the body-link hits
 * in a real mailbox.
 */
export function findThreadUnsubscribeTarget<M extends UnsubscribableMessage>(
  messages: readonly M[],
  { ownEmail, isSpam = false }: { ownEmail?: string | null; isSpam?: boolean } = {},
): { message: M; bodyLink: string | null } | null {
  const withHeader = messages.find((m) => m.list_unsubscribe);
  if (withHeader) return { message: withHeader, bodyLink: null };
  if (isSpam) return null;

  const own = ownEmail ? normalizeEmail(ownEmail) : null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.is_draft || !m.body_html || !m.from_address) continue;
    if (own && normalizeEmail(m.from_address) === own) continue;
    const link = findUnsubscribeLinkInHtml(m.body_html, { strongOnly: true });
    if (link) return { message: m, bodyLink: link };
  }
  return null;
}

/** Toast for an unsubscribe outcome, shared by every entry point. */
export function describeUnsubscribeResult(
  result: { method: string; success: boolean },
  sender: string,
): { kind: "info" | "error"; message: string } {
  if (!result.success) {
    return { kind: "error", message: t("settings.subscriptionManager.toastFailed", { sender }) };
  }
  const opened = result.method === "browser" || result.method === "browser_body";
  return {
    kind: "info",
    message: opened
      ? t("settings.subscriptionManager.toastBrowser", { sender })
      : t("settings.subscriptionManager.toastDone", { sender }),
  };
}
