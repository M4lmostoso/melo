import { getAttachmentsForMessage } from "../db/attachments";
import { getEmailProvider } from "./providerFactory";
import type { ComposerAttachment } from "@/stores/composerStore";

/**
 * Fetch the non-inline attachments of a message and return them as
 * ComposerAttachment objects ready to be pre-populated in a forward composer.
 * Errors for individual attachments are swallowed so a single failing fetch
 * does not abort the rest.
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
        // Normalize URL-safe base64 (Gmail API) → standard base64
        const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
        results.push({
          id: crypto.randomUUID(),
          filename: att.filename ?? "attachment",
          mimeType: att.mime_type ?? "application/octet-stream",
          size: att.size ?? 0,
          content: base64,
        });
      } catch (err) {
        console.warn(`[forwardAttachments] Failed to fetch attachment ${att.id}:`, err);
      }
    }),
  );

  return results;
}
