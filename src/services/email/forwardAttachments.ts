import { getAttachmentsForMessage } from "../db/attachments";
import { getEmailProvider } from "./providerFactory";
import type { ComposerAttachment } from "@/stores/composerStore";
import type { DbAttachment } from "../db/attachments";

const LOG = "[forwardAttachments]";

/**
 * Fetch the non-inline attachments of a message and return them as
 * ComposerAttachment objects ready to be pre-populated in a forward composer.
 */
export async function fetchForwardAttachments(
  accountId: string,
  messageId: string,
): Promise<ComposerAttachment[]> {
  const dbAttachments = await getAttachmentsForMessage(accountId, messageId);
  const nonInline = dbAttachments.filter(
    (a) => !a.is_inline && (a.gmail_attachment_id || a.imap_part_id) && a.filename,
  );
  if (nonInline.length === 0) return [];

  const provider = await getEmailProvider(accountId);
  const results: ComposerAttachment[] = [];

  await Promise.all(
    nonInline.map(async (att) => {
      const attachmentId = att.gmail_attachment_id ?? att.imap_part_id;
      if (!attachmentId) return;
      try {
        const { data } = await provider.fetchAttachment(messageId, attachmentId);
        const base64 = normalizeBase64(data);
        results.push({
          id: crypto.randomUUID(),
          filename: att.filename ?? "attachment",
          mimeType: att.mime_type ?? "application/octet-stream",
          size: att.size ?? 0,
          content: base64,
        });
      } catch (err) {
        console.error(`${LOG} attach FAILED ${att.id} (${att.filename}):`, err);
      }
    }),
  );

  return results;
}

function normalizeBase64(data: string): string {
  return data.replace(/-/g, "+").replace(/_/g, "/");
}

/**
 * Replaces all `cid:` references in the quoted HTML with base64 data URLs so
 * that inline images are visible in the compose window AND get correctly
 * embedded as MIME inline parts by emailBuilder.ts when the email is sent.
 *
 * Accepts multiple message IDs so it works for multi-message thread quotes.
 */
export async function resolveQuoteHtmlCids(
  accountId: string,
  messageIds: string[],
  html: string,
): Promise<string> {
  if (!html || !/\bcid:/i.test(html)) return html;

  // Collect all inline attachments across every message in the quote
  const allInline: (DbAttachment & { messageId: string })[] = [];
  for (const messageId of messageIds) {
    const atts = await getAttachmentsForMessage(accountId, messageId);
    for (const att of atts) {
      if (att.content_id) allInline.push({ ...att, messageId });
    }
  }
  if (allInline.length === 0) return html;

  const imapAtts = allInline.filter((a) => !!a.imap_part_id);
  const gmailAtts = allInline.filter((a) => !!a.gmail_attachment_id && !a.imap_part_id);

  const cidToDataUrl = new Map<string, string>();

  // --- IMAP: resolve via batch Rust command, then read cached file bytes ---
  if (imapAtts.length > 0) {
    const byMessage = new Map<string, typeof imapAtts>();
    for (const att of imapAtts) {
      const list = byMessage.get(att.messageId) ?? [];
      list.push(att);
      byMessage.set(att.messageId, list);
    }

    // Read cached file bytes via plugin-fs (NOT fetch(asset:) — the CSP connect-src
    // does not allow the asset: scheme, so a fetch would be blocked).
    const [{ resolveImapCidImages }, { readFile, BaseDirectory }] = await Promise.all([
      import("@/services/imap/imapCidResolver"),
      import("@tauri-apps/plugin-fs"),
    ]);

    for (const [messageId, atts] of byMessage) {
      try {
        const pathMap = await resolveImapCidImages(accountId, messageId, atts);

        for (const att of atts) {
          const localPath = pathMap.get(att.id);
          if (!localPath) continue;
          const cidKey = att.content_id!.replace(/[<>]/g, "").trim();
          if (cidToDataUrl.has(cidKey)) continue;
          try {
            const buf = await readFile(localPath, { baseDir: BaseDirectory.AppData });
            const base64 = uint8ToBase64(buf);
            const mime = att.mime_type ?? "image/jpeg";
            cidToDataUrl.set(cidKey, `data:${mime};base64,${base64}`);
          } catch (err) {
            console.warn(`${LOG} resolveCids IMAP read failed for ${att.id}:`, err);
          }
        }
      } catch (err) {
        console.warn(`${LOG} resolveCids IMAP batch failed for msg ${messageId}:`, err);
      }
    }
  }

  // --- Gmail: fetch each inline part via the HTTPS attachment API ----------
  if (gmailAtts.length > 0) {
    const provider = await getEmailProvider(accountId);
    await Promise.all(
      gmailAtts.map(async (att) => {
        const cidKey = att.content_id!.replace(/[<>]/g, "").trim();
        if (cidToDataUrl.has(cidKey)) return;
        try {
          const { data } = await provider.fetchAttachment(att.messageId, att.gmail_attachment_id!);
          const base64 = normalizeBase64(data);
          const mime = att.mime_type ?? "image/jpeg";
          cidToDataUrl.set(cidKey, `data:${mime};base64,${base64}`);
        } catch (err) {
          console.warn(`${LOG} resolveCids Gmail fetch failed for ${att.id}:`, err);
        }
      }),
    );
  }

  if (cidToDataUrl.size === 0) return html;

  return html.replace(/\bcid:([^"'\s)>]+)/gi, (_match, cid: string) => {
    const resolved = cidToDataUrl.get(cid.replace(/[<>]/g, "").trim());
    return resolved ?? `cid:${cid}`;
  });
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
