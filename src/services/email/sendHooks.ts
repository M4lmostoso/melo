/**
 * One-shot hooks fired the moment the SMTP server accepts a message (250),
 * keyed by the raw's RFC Message-ID.
 *
 * Why: the IMAP send path does more after the 250 — it looks for the copy in the
 * server's Sent folder (with backoff, DavMail can take a minute) and APPENDs
 * when needed. Draft cleanup used to wait for all of it, so for a 10 MB DavMail
 * send the server draft sat in Drafts (Outlook, phone) for ~95 s after the mail
 * had gone out (2026-11-09). Deleting the draft right after the 250 is safe: the
 * full raw is persisted in the Outgoing row until the send is fully settled, so
 * the draft is no longer anyone's last copy.
 *
 * A hook never fires on a refused send — the draft then stays, as before.
 * Providers that don't fire hooks (Gmail) simply leave the caller's normal
 * post-send cleanup in charge.
 */
type Hook = () => void | Promise<void>;

const hooks = new Map<string, Hook>();

function normalize(messageId: string): string {
  return messageId.trim().replace(/^<|>$/g, "").toLowerCase();
}

/**
 * Message-ID of a base64url raw, decoding only the start: headers come first,
 * and decoding a 10 MB attachment payload just to read one header is waste.
 */
export function messageIdFromRaw(rawBase64Url: string): string | null {
  try {
    const head = rawBase64Url.slice(0, 65_536 - (65_536 % 4));
    let b64 = head.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const text = atob(b64);
    const headers = text.split(/\r?\n\r?\n/, 1)[0] ?? text;
    const match = headers.match(/^message-id:\s*<?([^>\r\n]+)>?/im);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

/** Register `hook` for the message with this Message-ID. Returns an unregister fn. */
export function onSmtpAccepted(messageId: string, hook: Hook): () => void {
  const key = normalize(messageId);
  hooks.set(key, hook);
  return () => {
    if (hooks.get(key) === hook) hooks.delete(key);
  };
}

/**
 * Called by a provider right after the SMTP server accepted the message.
 * Fire-and-forget: the hook must never slow down or fail the send itself.
 */
export function fireSmtpAccepted(messageId: string | null | undefined): void {
  if (!messageId) return;
  const key = normalize(messageId);
  const hook = hooks.get(key);
  if (!hook) return;
  hooks.delete(key);
  try {
    void Promise.resolve(hook()).catch((err) => console.error("[sendHooks] smtp-accepted hook failed:", err));
  } catch (err) {
    console.error("[sendHooks] smtp-accepted hook failed:", err);
  }
}
