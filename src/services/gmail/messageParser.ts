import type { GmailMessage, GmailMessagePart, GmailHeader } from "./client";
import { parseAuthenticationResults } from "./authParser";
import { decodeHtml } from "@/utils/sanitize";
import { fixMojibake } from "@/utils/emailUtils";

export interface ParsedAttachment {
  filename: string;
  mimeType: string;
  size: number;
  gmailAttachmentId: string;
  contentId: string | null;
  isInline: boolean;
}

export interface ParsedMessage {
  id: string;
  threadId: string;
  fromAddress: string | null;
  fromName: string | null;
  toAddresses: string | null;
  ccAddresses: string | null;
  bccAddresses: string | null;
  replyTo: string | null;
  subject: string | null;
  snippet: string;
  date: number;
  isRead: boolean;
  isStarred: boolean;
  bodyHtml: string | null;
  bodyText: string | null;
  // When a text body part exceeds Gmail's inline size limit, `format=full` omits
  // `body.data` and serves the part via `body.attachmentId` instead. We record those
  // ids here so the sync can fetch the part separately and complete the body
  // (see `completeOversizedBodies`). Without this, large accumulated reply chains
  // lose their HTML body and fall back to plain-text rendering (or render empty).
  bodyHtmlAttachmentId: string | null;
  bodyTextAttachmentId: string | null;
  rawSize: number;
  internalDate: number;
  labelIds: string[];
  hasAttachments: boolean;
  attachments: ParsedAttachment[];
  listUnsubscribe: string | null;
  listUnsubscribePost: string | null;
  authResults: string | null;
}

export function parseGmailMessage(msg: GmailMessage): ParsedMessage {
  const headers = msg.payload.headers;
  const from = getHeader(headers, "From");
  const { name: fromName, address: fromAddress } = parseEmailAddress(from);

  const htmlPart = findBodyPart(msg.payload, "text/html");
  const textPart = findBodyPart(msg.payload, "text/plain");
  const attachments = extractAttachments(msg.payload);
  const authResult = parseAuthenticationResults(headers);

  return {
    id: msg.id,
    threadId: msg.threadId,
    fromAddress: fromAddress,
    fromName: applyMojibake(fromName),
    toAddresses: getHeader(headers, "To"),
    ccAddresses: getHeader(headers, "Cc"),
    bccAddresses: getHeader(headers, "Bcc"),
    replyTo: getHeader(headers, "Reply-To"),
    subject: applyMojibake(getHeader(headers, "Subject")),
    snippet: decodeHtml(msg.snippet),
    date: parseInt(msg.internalDate, 10),
    isRead: !msg.labelIds.includes("UNREAD"),
    isStarred: msg.labelIds.includes("STARRED"),
    bodyHtml: htmlPart?.body.data ? decodeBase64Url(htmlPart.body.data) : null,
    bodyText: textPart?.body.data ? decodeBase64Url(textPart.body.data) : null,
    // Record the attachmentId only when the inline data is absent — the signal that
    // this part was too big for Gmail to inline and must be fetched separately.
    bodyHtmlAttachmentId: htmlPart && !htmlPart.body.data ? (htmlPart.body.attachmentId ?? null) : null,
    bodyTextAttachmentId: textPart && !textPart.body.data ? (textPart.body.attachmentId ?? null) : null,
    rawSize: msg.sizeEstimate,
    internalDate: parseInt(msg.internalDate, 10),
    labelIds: msg.labelIds,
    hasAttachments: attachments.length > 0,
    attachments,
    listUnsubscribe: getHeader(headers, "List-Unsubscribe"),
    listUnsubscribePost: getHeader(headers, "List-Unsubscribe-Post"),
    authResults: authResult ? JSON.stringify(authResult) : null,
  };
}

function getHeader(headers: GmailHeader[], name: string): string | null {
  const header = headers.find(
    (h) => h.name.toLowerCase() === name.toLowerCase(),
  );
  return header?.value ?? null;
}

function applyMojibake(value: string | null): string | null {
  return value ? fixMojibake(value) : null;
}

function parseEmailAddress(raw: string | null): {
  name: string | null;
  address: string | null;
} {
  if (!raw) return { name: null, address: null };

  // Format: "Display Name <email@example.com>"
  const angleMatch = raw.match(/^"?([^"<]*)"?\s*<([^>]+)>$/);
  if (angleMatch) {
    const name = angleMatch[1]?.trim() || null;
    const address = angleMatch[2]?.trim() || null;
    return { name: name === address ? null : name, address };
  }

  // Bare email: "email@example.com"
  return { name: null, address: raw.trim() };
}

// Finds the first part matching `mimeType` that carries body bytes — either inline
// (`body.data`) or, for parts too large to inline, via `body.attachmentId`. Returning
// the part (not just the data) lets the caller detect the attachmentId case, which the
// old data-only `extractBody` silently dropped → NULL body_html for big messages.
function findBodyPart(part: GmailMessagePart, mimeType: string): GmailMessagePart | null {
  if (part.mimeType === mimeType && (part.body.data || part.body.attachmentId)) {
    return part;
  }

  if (part.parts) {
    for (const child of part.parts) {
      const result = findBodyPart(child, mimeType);
      if (result) return result;
    }
  }

  return null;
}

function extractAttachments(part: GmailMessagePart): ParsedAttachment[] {
  const results: ParsedAttachment[] = [];
  collectAttachments(part, results);
  return results;
}

function collectAttachments(
  part: GmailMessagePart,
  results: ParsedAttachment[],
): void {
  // A part carries its bytes either via body.attachmentId (fetched separately)
  // or, for small parts, inline in body.data with NO attachmentId. Gmail inlines
  // small attachments this way — handling only the attachmentId case silently
  // drops them (e.g. a small .xlsx next to a larger .pdf).
  if (part.body.attachmentId || part.body.data) {
    const contentIdHeader = part.headers?.find(
      (h) => h.name.toLowerCase() === "content-id",
    );
    const contentDisposition = part.headers?.find(
      (h) => h.name.toLowerCase() === "content-disposition",
    );
    const hasFilename = part.filename && part.filename.length > 0;
    const hasCid = !!contentIdHeader?.value;
    const isInline =
      contentDisposition?.value?.toLowerCase().startsWith("inline") ?? false;

    // Collect parts with a filename (regular attachments) or a Content-ID (CID
    // inline images). Body parts (text/plain, text/html) have neither and fall
    // through, so they're never mistaken for attachments.
    if (hasFilename || hasCid) {
      results.push({
        filename:
          part.filename ||
          contentIdHeader?.value?.replace(/[<>]/g, "") ||
          "inline",
        mimeType: part.mimeType,
        size: part.body.size,
        // When there's no attachmentId the bytes live inline in body.data; encode
        // the stable partId as a sentinel so the provider can re-fetch the message
        // and extract them at preview/download time.
        gmailAttachmentId: part.body.attachmentId ?? `inline:${part.partId}`,
        contentId: contentIdHeader?.value?.replace(/[<>]/g, "") ?? null,
        isInline: isInline && !hasFilename,
      });
    }
  }

  if (part.parts) {
    for (const child of part.parts) {
      collectAttachments(child, results);
    }
  }
}

/**
 * Completes bodies that Gmail did not inline. When a message's text/html (or
 * text/plain) part exceeds Gmail's `format=full` inline limit, `body.data` is empty
 * and the part is exposed only via `body.attachmentId`. `parseGmailMessage` records
 * those ids on `bodyHtmlAttachmentId` / `bodyTextAttachmentId`; this fetches them and
 * fills in `bodyHtml` / `bodyText` in place. Best-effort and serial (these messages
 * are rare — heavily accumulated reply chains) so it never floods the Gmail API.
 */
export async function completeOversizedBodies(
  messages: ParsedMessage[],
  fetchAttachment: (messageId: string, attachmentId: string) => Promise<{ data: string }>,
): Promise<void> {
  for (const msg of messages) {
    try {
      if (!msg.bodyHtml && msg.bodyHtmlAttachmentId) {
        const { data } = await fetchAttachment(msg.id, msg.bodyHtmlAttachmentId);
        if (data) msg.bodyHtml = decodeBase64Url(data);
      }
      if (!msg.bodyText && msg.bodyTextAttachmentId) {
        const { data } = await fetchAttachment(msg.id, msg.bodyTextAttachmentId);
        if (data) msg.bodyText = decodeBase64Url(data);
      }
    } catch {
      // Best-effort: leave the body null. The message still shows its snippet and any
      // other part that was inlined; a later sync can retry.
    }
  }
}

function decodeBase64Url(data: string): string {
  // Gmail uses URL-safe base64
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return decodeURIComponent(
      atob(base64)
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join(""),
    );
  } catch {
    // Fallback for binary data
    return atob(base64);
  }
}
