/**
 * Build an RFC 2822 email message and encode as base64url for the Gmail API.
 */
import { isInternalPlaceholderId } from "@/services/imap/syntheticMessageId";

export interface EmailAttachment {
  filename: string;
  mimeType: string;
  content: string; // base64-encoded content
}

export interface EmailDraft {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  htmlBody: string;
  inReplyTo?: string;
  references?: string;
  threadId?: string;
  attachments?: EmailAttachment[];
}

function base64UrlEncode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Standard base64 (with padding) of a UTF-8 string. */
function base64Encode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

/** Split a base64 payload into the 76-char lines RFC 2045 requires. */
function chunkBase64(b64: string): string[] {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) {
    lines.push(b64.slice(i, i + 76));
  }
  return lines;
}

const isAscii = (s: string) => !/[^\x20-\x7e]/.test(s);

/**
 * RFC 2047 encoded-word ("=?UTF-8?B?...?=") for header text that is not pure
 * ASCII. A header carrying raw 8-bit bytes is not a valid RFC 5322 message:
 * Exchange rejects the whole thing with ErrorMimeContentInvalid — which is how
 * an accented attachment name turned a real send into a mail that never left.
 * Encoded words are capped at 75 chars, so the text is split into chunks whose
 * UTF-8 encoding never straddles a character boundary.
 */
function encodeHeaderText(text: string): string {
  if (isAscii(text)) return text;
  const bytes = new TextEncoder().encode(text);
  // 75 - len("=?UTF-8?B?") - len("?=") = 63 base64 chars → 45 source bytes,
  // rounded down to a multiple of 3 so each chunk encodes without padding.
  const maxBytes = 45;
  const words: string[] = [];
  for (let i = 0; i < bytes.length; ) {
    let end = Math.min(i + maxBytes, bytes.length);
    // Never cut inside a multi-byte sequence: back off over continuation bytes.
    while (end > i && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    let binary = "";
    for (let j = i; j < end; j++) binary += String.fromCharCode(bytes[j]!);
    words.push(`=?UTF-8?B?${btoa(binary)}?=`);
    i = end;
  }
  return words.join("\r\n ");
}

/**
 * Encode the display name of a "Name <addr@host>" mailbox, leaving the
 * addr-spec untouched. Bare addresses pass through unchanged.
 */
function encodeAddressHeader(value: string): string {
  return value
    .split(",")
    .map((part) => {
      const mailbox = part.trim();
      const match = mailbox.match(/^(.*?)\s*<([^>]+)>$/);
      if (!match) return mailbox;
      const name = match[1]!.replace(/^"|"$/g, "").trim();
      if (!name) return `<${match[2]!}>`;
      if (isAscii(name)) {
        // Quote names carrying RFC 5322 specials; an encoded word must not be quoted.
        return /[()<>@,;:\\".[\]]/.test(name)
          ? `"${name.replace(/(["\\])/g, "\\$1")}" <${match[2]!}>`
          : `${name} <${match[2]!}>`;
      }
      return `${encodeHeaderText(name)} <${match[2]!}>`;
    })
    .join(", ");
}

/**
 * Filename parameter for Content-Type/Content-Disposition. ASCII names stay as
 * a plain quoted string; anything else also gets the RFC 2231 `filename*` form
 * so the bytes never appear raw in a header.
 */
function encodeFilenameParams(key: string, filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/(["\\])/g, "\\$1");
  if (isAscii(filename)) return `${key}="${ascii}"`;
  const pct = Array.from(new TextEncoder().encode(filename))
    .map((b) =>
      (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) ||
      b === 0x2d || b === 0x2e || b === 0x5f
        ? String.fromCharCode(b)
        : `%${b.toString(16).toUpperCase().padStart(2, "0")}`,
    )
    .join("");
  return `${key}="${ascii}"; ${key}*=UTF-8''${pct}`;
}

/**
 * Fold a header whose value is a list of whitespace/comma-separated tokens
 * (References, To, Cc) onto continuation lines. RFC 5322 caps a line at 998
 * octets, and a long reply chain's References or a 40-recipient Cc blows past
 * it — the same overflow that made Exchange reject whole messages.
 */
function foldHeader(name: string, value: string): string {
  const single = `${name}: ${value}`;
  if (single.length <= 78) return single;
  const tokens = value.split(/(?<=,)\s+|\s+/).filter(Boolean);
  const out: string[] = [];
  let current = `${name}:`;
  for (const token of tokens) {
    if (current.length + 1 + token.length > 78 && current !== `${name}:`) {
      out.push(current);
      current = ` ${token}`;
    } else {
      current += ` ${token}`;
    }
  }
  out.push(current);
  return out.join("\r\n");
}

/** Wrap a bare Message-ID in the angle brackets RFC 5322 requires. */
function bracketMessageId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed : `<${trimmed}>`;
}

function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function buildAlternativePart(boundary: string, htmlBody: string): string[] {
  const textContent = htmlToPlainText(htmlBody);
  const lines: string[] = [];

  // Both parts are base64'd: the bodies routinely carry accented text, and an
  // 8-bit body with no Content-Transfer-Encoding is not a valid MIME entity.
  // SMTP tolerated it; Exchange/DavMail rejects the message outright.
  lines.push(`--${boundary}`);
  lines.push("Content-Type: text/plain; charset=UTF-8");
  lines.push("Content-Transfer-Encoding: base64");
  lines.push("");
  lines.push(...chunkBase64(base64Encode(textContent.replace(/\r?\n/g, "\r\n"))));
  lines.push("");

  lines.push(`--${boundary}`);
  lines.push("Content-Type: text/html; charset=UTF-8");
  lines.push("Content-Transfer-Encoding: base64");
  lines.push("");
  lines.push(...chunkBase64(base64Encode(htmlBody.replace(/\r?\n/g, "\r\n"))));
  lines.push("");

  lines.push(`--${boundary}--`);
  return lines;
}

interface InlineImage {
  cid: string;
  mimeType: string;
  base64: string;
}

/**
 * Extract base64 data URLs from HTML and replace with cid: references.
 * Returns the modified HTML and extracted inline images.
 */
function extractInlineImages(html: string): { html: string; images: InlineImage[] } {
  const images: InlineImage[] = [];
  const processed = html.replace(
    /<img([^>]*)\ssrc="data:([^;]+);base64,([^"]+)"([^>]*)>/g,
    (_match, before: string, mime: string, data: string, after: string) => {
      const cid = `inline_${Date.now()}_${images.length}@melomail`;
      images.push({ cid, mimeType: mime, base64: data });
      return `<img${before} src="cid:${cid}"${after}>`;
    },
  );
  return { html: processed, images };
}

/**
 * Generate a unique Message-ID for outgoing emails.
 */
function generateMessageId(from: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 10);
  // `from` may be a full mailbox ("Name <addr@domain>") — extract the addr-spec
  // first, or the domain captures the closing ">" and every outgoing Message-ID
  // becomes "<id@domain>>" (double bracket), defeating sent-message dedup.
  const addr = from.match(/<([^>]+)>/)?.[1] ?? from;
  const domain = addr.includes("@") ? addr.split("@")[1]!.trim() : "melomail.local";
  return `<${timestamp}.${random}@${domain}>`;
}

export function buildRawEmail(draft: EmailDraft): string {
  const messageId = generateMessageId(draft.from);
  const lines: string[] = [
    foldHeader("From", encodeAddressHeader(draft.from)),
    foldHeader("To", encodeAddressHeader(draft.to.join(", "))),
  ];

  if (draft.cc && draft.cc.length > 0) {
    lines.push(foldHeader("Cc", encodeAddressHeader(draft.cc.join(", "))));
  }
  if (draft.bcc && draft.bcc.length > 0) {
    lines.push(foldHeader("Bcc", encodeAddressHeader(draft.bcc.join(", "))));
  }

  lines.push(`Date: ${new Date().toUTCString()}`);
  lines.push(`Message-ID: ${messageId}`);
  lines.push(`Subject: ${encodeHeaderText(draft.subject)}`);
  lines.push(`MIME-Version: 1.0`);

  // Messages with no Message-ID header carry an internal placeholder id
  // (`synthetic-...@melo.local`). It identifies the row inside Melo and means
  // nothing to any other mail system, so it must never be published in outgoing
  // threading headers — strip it instead of advertising a fake ancestor.
  // Melo stores Message-IDs bracket-stripped, so both headers have to be
  // re-bracketed here — a bare "id@host" is a syntax error that breaks
  // threading on the recipient's side and gets the message refused by Exchange.
  const inReplyTo = isInternalPlaceholderId(draft.inReplyTo)
    ? undefined
    : draft.inReplyTo
      ? bracketMessageId(draft.inReplyTo)
      : undefined;
  const references = draft.references
    ?.split(/\s+/)
    .filter((id) => id && !isInternalPlaceholderId(id))
    .map(bracketMessageId)
    .join(" ");

  if (inReplyTo) {
    lines.push(`In-Reply-To: ${inReplyTo}`);
  }
  if (references) {
    lines.push(foldHeader("References", references));
  }

  const { html: processedHtml, images: inlineImages } = extractInlineImages(draft.htmlBody);
  const hasAttachments = draft.attachments && draft.attachments.length > 0;
  const hasInlineImages = inlineImages.length > 0;

  if (hasAttachments || hasInlineImages) {
    const mixedBoundary = `----=_Mixed_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const relatedBoundary = `----=_Related_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const altBoundary = `----=_Alt_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    if (hasAttachments) {
      lines.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
      lines.push("");

      lines.push(`--${mixedBoundary}`);
    }

    if (hasInlineImages) {
      lines.push(`Content-Type: multipart/related; boundary="${relatedBoundary}"`);
      lines.push("");

      lines.push(`--${relatedBoundary}`);
      lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
      lines.push("");
      lines.push(...buildAlternativePart(altBoundary, processedHtml));
      lines.push("");

      // Inline image parts
      for (const img of inlineImages) {
        lines.push(`--${relatedBoundary}`);
        lines.push(`Content-Type: ${img.mimeType}`);
        lines.push("Content-Transfer-Encoding: base64");
        lines.push(`Content-ID: <${img.cid}>`);
        lines.push("Content-Disposition: inline");
        lines.push("");
        for (let i = 0; i < img.base64.length; i += 76) {
          lines.push(img.base64.slice(i, i + 76));
        }
        lines.push("");
      }
      lines.push(`--${relatedBoundary}--`);
    } else {
      // No inline images, just alternative
      lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
      lines.push("");
      lines.push(...buildAlternativePart(altBoundary, processedHtml));
    }

    if (hasAttachments) {
      lines.push("");
      // Attachment parts
      for (const att of draft.attachments!) {
        lines.push(`--${mixedBoundary}`);
        lines.push(`Content-Type: ${att.mimeType}; ${encodeFilenameParams("name", att.filename)}`);
        lines.push("Content-Transfer-Encoding: base64");
        lines.push(
          `Content-Disposition: attachment; ${encodeFilenameParams("filename", att.filename)}`,
        );
        lines.push("");
        const raw = att.content;
        for (let i = 0; i < raw.length; i += 76) {
          lines.push(raw.slice(i, i + 76));
        }
        lines.push("");
      }
      lines.push(`--${mixedBoundary}--`);
    }
  } else {
    const altBoundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
    lines.push("");
    lines.push(...buildAlternativePart(altBoundary, processedHtml));
  }

  return base64UrlEncode(lines.join("\r\n"));
}
