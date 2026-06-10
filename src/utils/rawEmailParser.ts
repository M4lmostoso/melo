export interface ParsedEmail {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  bodyHtml: string;
  inReplyTo: string | null;
}

export interface ParsedAttachment {
  filename: string;
  mimeType: string;
  content: string; // standard base64 (no line breaks)
  size: number;
}

export interface ParsedEmailFull {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  /** HTML body with inline cid: images rewritten back to data: URLs so they render in the composer. */
  bodyHtml: string;
  inReplyTo: string | null;
  references: string | null;
  /** Non-inline attachments, with their base64 content ready to re-attach. */
  attachments: ParsedAttachment[];
}

export function parseRawEmail(base64url: string): ParsedEmail {
  const empty: ParsedEmail = { from: "", to: [], cc: [], subject: "", bodyHtml: "", inReplyTo: null };
  try {
    const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

    const headerEnd = raw.indexOf("\r\n\r\n");
    const headerSection = headerEnd >= 0 ? raw.slice(0, headerEnd) : raw;
    const body = headerEnd >= 0 ? raw.slice(headerEnd + 4) : "";

    const headers: Record<string, string> = {};
    let currentKey = "";
    for (const line of headerSection.split("\r\n")) {
      if ((line.startsWith(" ") || line.startsWith("\t")) && currentKey) {
        headers[currentKey] += " " + line.trim();
      } else {
        const colon = line.indexOf(":");
        if (colon > 0) {
          currentKey = line.slice(0, colon).toLowerCase();
          headers[currentKey] = line.slice(colon + 1).trim();
        }
      }
    }

    const splitAddresses = (h: string | undefined): string[] =>
      h ? h.split(",").map((a) => a.trim()).filter(Boolean) : [];

    return {
      from: headers["from"] ?? "",
      to: splitAddresses(headers["to"]),
      cc: splitAddresses(headers["cc"]),
      subject: headers["subject"] ?? "",
      bodyHtml: extractHtmlPart(body, headers["content-type"] ?? ""),
      inReplyTo: headers["in-reply-to"] ?? null,
    };
  } catch {
    return empty;
  }
}

// ---------------------------------------------------------------------------
// Full MIME parser — used to reopen a queued/failed Outgoing email in the composer
// with EVERYTHING preserved: recipients (incl. BCC), body, inline images, and
// attachments (with their decoded base64 content). Unlike parseRawEmail above, this
// walks the whole MIME tree rather than just pulling the HTML body.
// ---------------------------------------------------------------------------

interface MimeLeaf {
  mimeType: string;
  filename: string | null;
  contentId: string | null;
  disposition: string;
  /** Cleaned standard base64 of the raw bytes (always, regardless of source CTE). */
  base64: string;
  /** Decoded text (for text/* parts), UTF-8. */
  text: string;
}

function parseHeaderBlock(headerSection: string): Record<string, string> {
  const headers: Record<string, string> = {};
  let currentKey = "";
  for (const line of headerSection.split("\r\n")) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && currentKey) {
      headers[currentKey] += " " + line.trim();
    } else {
      const colon = line.indexOf(":");
      if (colon > 0) {
        currentKey = line.slice(0, colon).toLowerCase();
        headers[currentKey] = line.slice(colon + 1).trim();
      }
    }
  }
  return headers;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function decodeBase64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, "");
  try {
    const binary = atob(clean);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
}

function decodeQuotedPrintableToBytes(input: string): Uint8Array {
  const joined = input.replace(/=\r?\n/g, "");
  const out: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    const ch = joined[i]!;
    if (ch === "=" && i + 2 < joined.length) {
      const hex = joined.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    out.push(ch.charCodeAt(0) & 0xff);
  }
  return Uint8Array.from(out);
}

/** Decode a leaf body to raw bytes according to its Content-Transfer-Encoding. */
function decodeLeafBytes(body: string, cte: string): Uint8Array {
  const enc = cte.toLowerCase().trim();
  if (enc === "base64") return decodeBase64ToBytes(body);
  if (enc === "quoted-printable") return decodeQuotedPrintableToBytes(body);
  // 7bit / 8bit / binary / none — body is already the literal content
  return new TextEncoder().encode(body);
}

function walkLeaves(raw: string, leaves: MimeLeaf[]): void {
  const sepIdx = raw.indexOf("\r\n\r\n");
  if (sepIdx === -1) return;
  const headers = parseHeaderBlock(raw.slice(0, sepIdx));
  const body = raw.slice(sepIdx + 4);

  const ct = headers["content-type"] ?? "text/plain";
  const ctLow = ct.toLowerCase().trimStart();

  if (ctLow.startsWith("multipart/")) {
    const boundaryMatch = ct.match(/boundary="([^"]+)"|boundary=([^\s;]+)/i);
    if (!boundaryMatch) return;
    const boundary = (boundaryMatch[1] ?? boundaryMatch[2])!;
    const delimiter = `\r\n--${boundary}`;
    let pos = body.indexOf(`--${boundary}`);
    if (pos === -1) return;
    pos += `--${boundary}`.length;
    if (body.startsWith("\r\n", pos)) pos += 2;
    while (true) {
      const nextDelim = body.indexOf(delimiter, pos);
      if (nextDelim === -1) break;
      walkLeaves(body.slice(pos, nextDelim), leaves);
      pos = nextDelim + delimiter.length;
      if (body.startsWith("--", pos)) break; // closing --boundary--
      if (body.startsWith("\r\n", pos)) pos += 2;
    }
    return;
  }

  const cte = headers["content-transfer-encoding"] ?? "7bit";
  const bytes = decodeLeafBytes(body.replace(/\r\n$/, ""), cte);
  const cd = headers["content-disposition"] ?? "";
  const filename =
    cd.match(/filename\*?="?([^";\r\n]+)"?/i)?.[1]?.trim() ??
    ct.match(/name\*?="?([^";\r\n]+)"?/i)?.[1]?.trim() ??
    null;
  const contentId = headers["content-id"]?.replace(/^<|>$/g, "") ?? null;
  leaves.push({
    mimeType: (ctLow.split(";")[0] ?? "application/octet-stream").trim(),
    filename,
    contentId,
    disposition: cd.toLowerCase().trimStart(),
    base64: bytesToBase64(bytes),
    text: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
  });
}

function splitAddressesPublic(h: string | undefined): string[] {
  return h ? h.split(",").map((a) => a.trim()).filter(Boolean) : [];
}

export function parseRawEmailFull(base64url: string): ParsedEmailFull {
  const empty: ParsedEmailFull = {
    to: [], cc: [], bcc: [], subject: "", bodyHtml: "",
    inReplyTo: null, references: null, attachments: [],
  };
  try {
    const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

    const headerEnd = raw.indexOf("\r\n\r\n");
    const topHeaders = parseHeaderBlock(headerEnd >= 0 ? raw.slice(0, headerEnd) : raw);

    const leaves: MimeLeaf[] = [];
    walkLeaves(raw, leaves);

    // Pick the HTML body (fall back to the first text/plain wrapped in <pre>).
    const htmlLeaf = leaves.find((l) => l.mimeType === "text/html" && !l.filename);
    const textLeaf = leaves.find((l) => l.mimeType === "text/plain" && !l.filename);
    let bodyHtml = htmlLeaf?.text.trim() ?? "";
    if (!bodyHtml && textLeaf) {
      bodyHtml = `<div>${textLeaf.text.replace(/\n/g, "<br>")}</div>`;
    }

    // Re-inline cid: images so they render in the editor (and get re-extracted on resend).
    const inlineByCid = new Map<string, MimeLeaf>();
    for (const l of leaves) {
      if (l.contentId && l.mimeType.startsWith("image/")) inlineByCid.set(l.contentId, l);
    }
    if (inlineByCid.size > 0) {
      bodyHtml = bodyHtml.replace(/src="cid:([^"]+)"/gi, (m, cid: string) => {
        const img = inlineByCid.get(cid);
        return img ? `src="data:${img.mimeType};base64,${img.base64}"` : m;
      });
    }

    // Real attachments: explicit attachment disposition, or any named non-text part that
    // isn't an inline image referenced by the HTML.
    const attachments: ParsedAttachment[] = leaves
      .filter((l) => {
        const isInlineImage = !!l.contentId && l.mimeType.startsWith("image/");
        const named = !!l.filename;
        const isAttachmentDisp = l.disposition.startsWith("attachment");
        return (isAttachmentDisp || named) && !isInlineImage;
      })
      .map((l) => ({
        filename: l.filename ?? "attachment",
        mimeType: l.mimeType,
        content: l.base64,
        size: Math.floor((l.base64.replace(/=+$/, "").length * 3) / 4),
      }));

    return {
      to: splitAddressesPublic(topHeaders["to"]),
      cc: splitAddressesPublic(topHeaders["cc"]),
      bcc: splitAddressesPublic(topHeaders["bcc"]),
      subject: topHeaders["subject"] ?? "",
      bodyHtml,
      inReplyTo: topHeaders["in-reply-to"] ?? null,
      references: topHeaders["references"] ?? null,
      attachments,
    };
  } catch {
    return empty;
  }
}

function extractHtmlPart(body: string, contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.startsWith("text/html")) return body.trim();
  if (ct.startsWith("text/plain")) return "";

  const boundaryMatch = /boundary="([^"]+)"/i.exec(contentType);
  if (!boundaryMatch) return body.trim();

  const boundary = boundaryMatch[1] ?? "";
  const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = body.split(new RegExp(`--${escaped}(?:--)?`));

  for (const part of parts) {
    if (!part.trim() || part.trim() === "--") continue;
    const partEnd = part.indexOf("\r\n\r\n");
    if (partEnd < 0) continue;
    const partHeaders = part.slice(0, partEnd);
    const partBody = part.slice(partEnd + 4);
    const partCt = /Content-Type:\s*([^\r\n]+)/i.exec(partHeaders)?.[1] ?? "";
    const partCtLow = partCt.toLowerCase();

    if (partCtLow.startsWith("text/html")) return partBody.trim();
    if (partCtLow.startsWith("multipart/")) {
      const nested = extractHtmlPart(partBody, partCt);
      if (nested) return nested;
    }
  }
  return "";
}
