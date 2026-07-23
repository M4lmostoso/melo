import { decodeHtml } from "@/utils/sanitize";
import type { EmailProvider, EmailFolder, SyncResult } from "./types";
import type { ParsedMessage } from "../gmail/messageParser";
import { buildImapConfig, buildSmtpConfig } from "../imap/imapConfigBuilder";
import { imapInitialSync, imapDeltaSync } from "../imap/imapSync";
import { mapFolderToLabel, getLabelsForMessage, getSyncableFolders } from "../imap/folderMapper";
import {
  imapListFolders,
  imapSetFlags,
  imapMoveMessages,
  imapDeleteMessages,
  imapFetchMessageBody,
  imapFetchAttachment,
  imapDownloadAttachmentToPath,
  imapBatchDownloadAttachments,
  imapFetchRawMessage,
  imapTestConnection,
  imapAppendMessage,
  smtpSendEmail,
  smtpTestConnection,
  type ImapConfig,
  type SmtpConfig,
} from "../imap/tauriCommands";
import { getAccount, type DbAccount } from "../db/accounts";
import { findSpecialFolder } from "../imap/messageHelper";
import { ensureFreshToken } from "../oauth/oauthTokenManager";
import { upsertMessage, getMessagesForThread } from "../db/messages";
import { upsertAttachment } from "../db/attachments";
import { getDb } from "../db/connection";
import {
  upsertThread,
  setThreadLabels,
  getThreadLabelIds,
  recalculateThreadStats,
} from "../db/threads";

/**
 * Decode base64url (Gmail/RFC 4648 URL-safe, no padding) to a UTF-8 string.
 */
function base64UrlDecode(input: string): string {
  // Convert base64url to standard base64
  let base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  // Add padding if needed
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Parse basic RFC 2822 headers from a raw email string.
 * Returns a map of header name (lowercase) → header value.
 */
function parseBasicHeaders(raw: string): Map<string, string> {
  const headers = new Map<string, string>();
  // Headers end at the first blank line
  const headerEnd = raw.indexOf("\r\n\r\n");
  const headerSection = headerEnd !== -1 ? raw.slice(0, headerEnd) : raw;

  // Unfold continuation lines (lines starting with space/tab are continuations)
  const unfolded = headerSection.replace(/\r\n([ \t])/g, " ");

  for (const line of unfolded.split("\r\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const name = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();
    headers.set(name, value);
  }

  return headers;
}

/**
 * Extract a plain-text snippet from a raw RFC 2822 email body.
 */
function extractPlainText(raw: string): string | null {
  const bodyStart = raw.indexOf("\r\n\r\n");
  if (bodyStart === -1) return null;

  const body = raw.slice(bodyStart + 4);
  const contentType = parseBasicHeaders(raw).get("content-type") ?? "";
  const ctLow = contentType.toLowerCase();

  if (!ctLow.startsWith("multipart/")) {
    return ctLow.startsWith("text/plain") ? body : null;
  }

  const boundaryMatch = contentType.match(/boundary="?([^";\s]+)"?/i);
  if (!boundaryMatch) return null;
  const boundary = boundaryMatch[1]!;

  const parts = body.split(`--${boundary}`);
  for (const part of parts) {
    if (part === "--" || part.trim() === "") continue;
    const partHeaderEnd = part.indexOf("\r\n\r\n");
    if (partHeaderEnd === -1) continue;
    const partHeaders = part.slice(0, partHeaderEnd);
    const partBody = part.slice(partHeaderEnd + 4);
    const partCT = (partHeaders.match(/content-type:\s*([^\r\n]+)/i)?.[1] ?? "").toLowerCase();

    if (partCT.startsWith("text/plain")) {
      return partBody.replace(/\r\n--[^\r\n]+(--)?\s*$/, "");
    }
    if (partCT.startsWith("multipart/")) {
      const nested = extractPlainText(part.replace(/^\r\n/, ""));
      if (nested !== null) return nested;
    }
  }
  return null;
}

function extractSnippet(raw: string, maxLen = 200): string {
  const plain = extractPlainText(raw);
  const body = plain ?? (() => {
    const bodyStart = raw.indexOf("\r\n\r\n");
    return bodyStart !== -1 ? raw.slice(bodyStart + 4) : "";
  })();

  const stripped = body
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);

  return decodeHtml(stripped);
}

/**
 * Extract the text/html part from a raw RFC 2822 email, handling nested
 * multipart/related and multipart/alternative structures recursively.
 * Returns null when no HTML part is found (plain-text-only emails).
 */
function extractHtmlBody(raw: string): string | null {
  const bodyStart = raw.indexOf("\r\n\r\n");
  if (bodyStart === -1) return null;

  const body = raw.slice(bodyStart + 4);
  const contentType = parseBasicHeaders(raw).get("content-type") ?? "";

  // Non-multipart — if it IS text/html return as-is, otherwise no HTML
  if (!contentType.toLowerCase().startsWith("multipart/")) {
    return contentType.toLowerCase().startsWith("text/html") ? body : null;
  }

  const boundaryMatch = contentType.match(/boundary="?([^";\s]+)"?/i);
  if (!boundaryMatch) return null;
  const boundary = boundaryMatch[1]!;

  const parts = body.split(`--${boundary}`);
  for (const part of parts) {
    if (part === "--" || part.trim() === "") continue;
    const partHeaderEnd = part.indexOf("\r\n\r\n");
    if (partHeaderEnd === -1) continue;
    const partHeaders = part.slice(0, partHeaderEnd);
    const partBody = part.slice(partHeaderEnd + 4);
    const partCT = (partHeaders.match(/content-type:\s*([^\r\n]+)/i)?.[1] ?? "").toLowerCase();

    if (partCT.startsWith("text/html")) {
      // Strip trailing MIME boundary marker (--boundary or --boundary--)
      return partBody.replace(/\r\n--[^\r\n]+(--)?\s*$/, "").trim();
    }
    if (partCT.startsWith("multipart/")) {
      // Recurse into nested multipart (e.g. multipart/related → multipart/alternative).
      // `part` already has the sub-message headers + body in RFC 2822 format.
      const nested = extractHtmlBody(part.replace(/^\r\n/, ""));
      if (nested) return nested;
    }
  }
  return null;
}

interface RawMimeAttachment {
  partId: string;
  filename: string;
  mimeType: string;
  size: number;
  contentId: string | null;
  isInline: boolean;
}

/**
 * Walk the MIME tree of a raw RFC 2822 message and collect all attachment parts
 * with their IMAP-compatible part IDs (e.g. "2", "3", "1.2").
 */
function walkMimePart(
  raw: string,
  partPrefix: string,
  results: RawMimeAttachment[],
): void {
  const sepIdx = raw.indexOf("\r\n\r\n");
  if (sepIdx === -1) return;

  const headerSection = raw.slice(0, sepIdx);
  const body = raw.slice(sepIdx + 4);

  const ctLine = headerSection.match(/^content-type:\s*([^\r\n]+(?:\r\n[ \t][^\r\n]+)*)/im)?.[1] ?? "";
  const ctLow = ctLine.toLowerCase().trimStart();

  if (ctLow.startsWith("multipart/")) {
    const boundaryMatch = ctLine.match(/boundary="([^"]+)"|boundary=([^\s;]+)/i);
    if (!boundaryMatch) return;
    const boundary = (boundaryMatch[1] ?? boundaryMatch[2])!;
    const delimiter = `\r\n--${boundary}`;

    // Find the first part boundary
    let pos = body.indexOf(`--${boundary}`);
    if (pos === -1) return;
    pos += `--${boundary}`.length;
    // Skip CRLF after boundary
    if (body.startsWith("\r\n", pos)) pos += 2;

    let idx = 1;
    while (true) {
      const nextDelim = body.indexOf(delimiter, pos);
      if (nextDelim === -1) break;
      const partRaw = body.slice(pos, nextDelim);
      const subId = partPrefix ? `${partPrefix}.${idx}` : `${idx}`;
      walkMimePart(partRaw, subId, results);
      idx++;
      pos = nextDelim + delimiter.length;
      if (body.startsWith("--", pos)) break; // closing --boundary--
      if (body.startsWith("\r\n", pos)) pos += 2;
    }
  } else {
    // Leaf part — check if it's an attachment
    const cdLine = headerSection.match(/^content-disposition:\s*([^\r\n]+(?:\r\n[ \t][^\r\n]+)*)/im)?.[1] ?? "";
    const filenameFromCD =
      cdLine.match(/filename\*?="?([^";\r\n]+)"?/i)?.[1]?.trim() ?? null;
    const filenameFromCT =
      ctLine.match(/name\*?="?([^";\r\n]+)"?/i)?.[1]?.trim() ?? null;
    const filename = filenameFromCD ?? filenameFromCT;
    const cidRaw = headerSection.match(/^content-id:\s*<([^>]+)>/im)?.[1] ?? null;
    const isInline = cdLine.toLowerCase().trimStart().startsWith("inline");
    // A part referenced via cid: (Content-ID present) is an inline attachment even
    // when it has neither Content-Disposition: attachment nor a filename — that's
    // exactly how the composer emits inline images (emailBuilder.ts), and skipping
    // them here means saveSentMessageLocally never records the attachment row the
    // cid: resolver needs, so the just-sent image (and any image-based signature)
    // renders as a blank placeholder until a later full sync happens to fix it up.
    const isAttachment = cdLine.toLowerCase().trimStart().startsWith("attachment") || !!filename || !!cidRaw;

    if (isAttachment) {
      const mimeType = (ctLow.split(";")[0] ?? "application/octet-stream").trim();
      // Estimate decoded byte size from base64-encoded body length
      const encodedLen = body.replace(/[\r\n]/g, "").length;
      const size = Math.floor(encodedLen * 0.75);
      results.push({
        partId: partPrefix || "1",
        filename: filename ?? "attachment",
        mimeType,
        size,
        contentId: cidRaw,
        isInline: (isInline || !!cidRaw) && !filename,
      });
    }
  }
}

function extractRawMimeAttachments(raw: string): RawMimeAttachment[] {
  const results: RawMimeAttachment[] = [];
  walkMimePart(raw, "", results);
  return results;
}

/**
 * EmailProvider adapter for IMAP/SMTP accounts.
 * Delegates to Tauri IMAP/SMTP commands via the imapSync engine.
 */
export class ImapSmtpProvider implements EmailProvider {
  readonly accountId: string;
  readonly type = "imap" as const;

  private _imapConfig: ImapConfig | null = null;
  private _smtpConfig: SmtpConfig | null = null;

  constructor(accountId: string) {
    this.accountId = accountId;
  }

  private async getAccount(): Promise<DbAccount> {
    const account = await getAccount(this.accountId);
    if (!account) {
      throw new Error(`Account ${this.accountId} not found`);
    }
    return account;
  }

  private async getImapConfig(): Promise<ImapConfig> {
    const account = await this.getAccount();
    if (account.auth_method === "oauth2") {
      // OAuth accounts need a fresh token every time
      const token = await ensureFreshToken(account);
      return buildImapConfig(account, token);
    }
    if (!this._imapConfig) {
      this._imapConfig = buildImapConfig(account);
    }
    return this._imapConfig;
  }

  private async getSmtpConfig(): Promise<SmtpConfig> {
    const account = await this.getAccount();
    if (account.auth_method === "oauth2") {
      const token = await ensureFreshToken(account);
      return buildSmtpConfig(account, token);
    }
    if (!this._smtpConfig) {
      this._smtpConfig = buildSmtpConfig(account);
    }
    return this._smtpConfig;
  }

  /**
   * Invalidate cached configs (e.g., after password change).
   */
  clearConfigCache(): void {
    this._imapConfig = null;
    this._smtpConfig = null;
  }

  // ---- Folder/Label operations ----

  async listFolders(): Promise<EmailFolder[]> {
    const config = await this.getImapConfig();
    const imapFolders = await imapListFolders(config);
    const syncable = getSyncableFolders(imapFolders);

    return syncable.map((f) => {
      const mapping = mapFolderToLabel(f);
      return {
        id: mapping.labelId,
        name: mapping.labelName,
        path: f.path,
        type: mapping.type as "system" | "user",
        specialUse: f.special_use,
        delimiter: f.delimiter,
        messageCount: f.exists,
        unreadCount: f.unseen,
      };
    });
  }

  async createFolder(
    _name: string,
    _parentPath?: string,
  ): Promise<EmailFolder> {
    throw new Error(
      "Creating folders is not supported for IMAP accounts via the current command set. " +
        "Please create the folder directly on the mail server.",
    );
  }

  async deleteFolder(_path: string): Promise<void> {
    throw new Error(
      "Deleting folders is not supported for IMAP accounts via the current command set. " +
        "Please delete the folder directly on the mail server.",
    );
  }

  async renameFolder(_path: string, _newName: string): Promise<void> {
    throw new Error(
      "Renaming folders is not supported for IMAP accounts via the current command set. " +
        "Please rename the folder directly on the mail server.",
    );
  }

  // ---- Sync operations ----

  async initialSync(
    daysBack: number,
    onProgress?: (phase: string, current: number, total: number) => void,
  ): Promise<SyncResult> {
    return imapInitialSync(
      this.accountId,
      daysBack,
      onProgress
        ? (p) => {
            onProgress(p.phase, p.current, p.total);
          }
        : undefined,
    );
  }

  async deltaSync(_syncToken: string): Promise<SyncResult> {
    return imapDeltaSync(this.accountId);
  }

  // ---- Message operations ----

  async fetchMessage(messageId: string): Promise<ParsedMessage> {
    // Prefer imap_folder/imap_uid from DB — the UID encoded in the message ID may
    // differ from the real server UID when APPENDUID returned an incorrect value.
    const dbRows = await (await getDb()).select<{ imap_folder: string | null; imap_uid: number | null }[]>(
      "SELECT imap_folder, imap_uid FROM messages WHERE id = $1 AND account_id = $2 LIMIT 1",
      [messageId, this.accountId],
    );
    const { folder: parsedFolder, uid: parsedUid } = this.parseImapMessageId(messageId);
    const folder = dbRows[0]?.imap_folder ?? parsedFolder;
    const uid = dbRows[0]?.imap_uid ?? parsedUid;

    if (uid === null || !folder) {
      throw new Error(`Invalid IMAP message ID format: ${messageId}`);
    }

    const config = await this.getImapConfig();
    const imapMsg = await imapFetchMessageBody(config, folder, uid);

    // Build ParsedMessage inline — on-demand fetch includes body_html + body_text
    const folderMapping = mapFolderToLabel({
      path: folder, raw_path: folder, name: folder,
      delimiter: "/", special_use: null, exists: 0, unseen: 0,
      parent_path: null, has_children: false,
    });
    const labelIds = getLabelsForMessage(
      { labelId: folderMapping.labelId, labelName: "", type: "" },
      imapMsg.is_read, imapMsg.is_starred, imapMsg.is_draft,
    );
    const snippet = imapMsg.snippet ?? "";
    const attachments = imapMsg.attachments.map((att) => ({
      filename: att.filename,
      mimeType: att.mime_type,
      size: att.size,
      gmailAttachmentId: att.part_id,
      contentId: att.content_id,
      isInline: att.is_inline,
    }));
    const parsed: ParsedMessage = {
      id: messageId,
      threadId: "",
      fromAddress: imapMsg.from_address,
      fromName: imapMsg.from_name,
      toAddresses: imapMsg.to_addresses,
      ccAddresses: imapMsg.cc_addresses,
      bccAddresses: imapMsg.bcc_addresses,
      replyTo: imapMsg.reply_to,
      subject: imapMsg.subject,
      snippet,
      date: imapMsg.date,
      isRead: imapMsg.is_read || imapMsg.is_draft,
      isStarred: imapMsg.is_starred,
      bodyHtml: imapMsg.body_html,
      bodyText: imapMsg.body_text,
      // IMAP fetches the full body directly — no Gmail-style oversized-part indirection.
      bodyHtmlAttachmentId: null,
      bodyTextAttachmentId: null,
      rawSize: imapMsg.raw_size,
      internalDate: imapMsg.date,
      labelIds,
      hasAttachments: attachments.length > 0,
      attachments,
      listUnsubscribe: imapMsg.list_unsubscribe,
      listUnsubscribePost: imapMsg.list_unsubscribe_post,
      authResults: imapMsg.auth_results,
    };
    return parsed;
  }

  async fetchAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<{ data: string; size: number }> {
    const db = await getDb();
    const rows = await db.select<{ imap_folder: string | null; imap_uid: number | null }[]>(
      "SELECT imap_folder, imap_uid FROM messages WHERE id = $1 AND account_id = $2 LIMIT 1",
      [messageId, this.accountId],
    );
    const dbFolder = rows[0]?.imap_folder ?? null;
    const dbUid = rows[0]?.imap_uid ?? null;

    const { folder: parsedFolder, uid: parsedUid } = this.parseImapMessageId(messageId);
    const folder = dbFolder ?? parsedFolder;
    const uid = dbUid ?? parsedUid;

    if (!folder || uid === null) {
      throw new Error(`Cannot resolve IMAP location for message: ${messageId}`);
    }

    const config = await this.getImapConfig();
    const data = await imapFetchAttachment(config, folder, uid, attachmentId);
    return { data, size: data.length };
  }

  async downloadAttachmentToPath(
    messageId: string,
    attachmentId: string,
    destPath: string,
    dbId: string,
    totalSize: number,
  ): Promise<void> {
    // Prefer imap_folder/imap_uid from the DB — these stay current through syncs
    // and folder moves, whereas the synthetic message ID encodes the original folder.
    const db = await getDb();
    const rows = await db.select<{ imap_folder: string | null; imap_uid: number | null }[]>(
      "SELECT imap_folder, imap_uid FROM messages WHERE id = $1 AND account_id = $2 LIMIT 1",
      [messageId, this.accountId],
    );
    const dbFolder = rows[0]?.imap_folder ?? null;
    const dbUid = rows[0]?.imap_uid ?? null;

    const { folder: parsedFolder, uid: parsedUid } = this.parseImapMessageId(messageId);
    const folder = dbFolder ?? parsedFolder;
    const uid = dbUid ?? parsedUid;

    if (!folder || uid === null) {
      throw new Error(`Cannot resolve IMAP location for message: ${messageId}`);
    }

    console.log(`[imap] download folder=${folder} uid=${uid} part=${attachmentId} size=${totalSize}`);
    const config = await this.getImapConfig();
    await imapDownloadAttachmentToPath(config, folder, uid, attachmentId, destPath, dbId, totalSize);
    console.log(`[imap] download done`);
  }

  async downloadAttachmentsBatch(
    items: { messageId: string; attachmentId: string; destPath: string; dbId: string }[],
  ): Promise<{ dbId: string; ok: boolean; error: string | null }[]> {
    // Multi-attachment messages: one BODY.PEEK[] per message in Rust — avoids
    // the per-part fetch that DavMail mangles into a near-full-message transfer
    // (an N-attachment email was costing ~N × the message). Single-attachment
    // messages keep the per-part streaming path: on healthy servers it fetches
    // only that MIME part (a full-message fetch would waste bandwidth) and it
    // reports real byte-level progress; on DavMail it costs ~one message either
    // way.
    const byMessage = new Map<string, typeof items>();
    for (const it of items) {
      const g = byMessage.get(it.messageId);
      if (g) g.push(it);
      else byMessage.set(it.messageId, [it]);
    }

    const results: { dbId: string; ok: boolean; error: string | null }[] = [];
    const batched: typeof items = [];
    for (const group of byMessage.values()) {
      if (group.length === 1) {
        const it = group[0]!;
        try {
          await this.downloadAttachmentToPath(it.messageId, it.attachmentId, it.destPath, it.dbId, 0);
          results.push({ dbId: it.dbId, ok: true, error: null });
        } catch (err) {
          results.push({ dbId: it.dbId, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      } else {
        batched.push(...group);
      }
    }

    if (batched.length > 0) {
      const config = await this.getImapConfig();
      const requests = batched.map((it) => ({
        messageId: it.messageId,
        partId: it.attachmentId,
        destPath: it.destPath,
        dbId: it.dbId,
      }));
      console.log(`[imap] batch download ${requests.length} attachment(s)`);
      results.push(...await imapBatchDownloadAttachments(config, requests));
      console.log(`[imap] batch download done`);
    }
    return results;
  }

  async fetchRawMessage(messageId: string): Promise<string> {
    const { folder, uid } = this.parseImapMessageId(messageId);

    if (uid === null || !folder) {
      throw new Error(`Invalid IMAP message ID format: ${messageId}`);
    }

    const config = await this.getImapConfig();
    return imapFetchRawMessage(config, folder, uid);
  }

  // ---- Actions ----

  // ---- Shared helpers ----

  /**
   * Resolve the folder→UIDs map for an action.
   * When callers pass explicit messageIds (from the ActionBar), look up the
   * actual imap_uid from the DB instead of parsing the UID from the local ID
   * name. The local ID suffix may differ from the server UID when APPENDUID
   * returned an incorrect value (observed on Exchange-backed IMAP servers),
   * which would cause operations to target the wrong message on the server.
   * Falls back to parsing the local ID only for rows not found in the DB.
   * When callers pass [] (keyboard shortcuts, multi-select), fetch all thread
   * messages from DB and use imap_folder / imap_uid directly — avoids stale
   * synthetic IDs after a message has been moved between folders.
   */
  private async resolveGrouped(
    threadId: string,
    messageIds: string[],
  ): Promise<Map<string, number[]>> {
    if (messageIds.length > 0) {
      // Primary: look up imap_uid from DB — the local ID name suffix may be the
      // APPENDUID value, not the real server UID.
      const db = await getDb();
      const placeholders = messageIds.map((_, i) => `$${i + 2}`).join(",");
      const rows = await db.select<{ id: string; imap_folder: string; imap_uid: number }[]>(
        `SELECT id, imap_folder, imap_uid FROM messages
         WHERE account_id = $1 AND id IN (${placeholders})
           AND imap_folder IS NOT NULL AND imap_uid IS NOT NULL`,
        [this.accountId, ...messageIds],
      );
      const grouped = new Map<string, number[]>();
      const foundIds = new Set<string>();
      for (const row of rows) {
        foundIds.add(row.id);
        const existing = grouped.get(row.imap_folder);
        if (existing) existing.push(row.imap_uid);
        else grouped.set(row.imap_folder, [row.imap_uid]);
      }
      // Fallback: parse any IDs not found in DB from the local ID name
      const missing = messageIds.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        for (const [folder, uids] of this.groupByFolder(missing)) {
          const existing = grouped.get(folder);
          if (existing) existing.push(...uids);
          else grouped.set(folder, uids);
        }
      }
      return grouped;
    }
    // includeTrashed=true: whole-thread operations (empty messageIds) must still resolve
    // messages that were just marked is_trashed=1 by the optimistic local update, otherwise
    // the server move/delete would find nothing.
    const msgs = await getMessagesForThread(this.accountId, threadId, true);
    const grouped = new Map<string, number[]>();
    for (const m of msgs) {
      if (!m.imap_folder || m.imap_uid == null) continue;
      const existing = grouped.get(m.imap_folder);
      if (existing) existing.push(m.imap_uid);
      else grouped.set(m.imap_folder, [m.imap_uid]);
    }
    return grouped;
  }

  async archive(threadId: string, messageIds: string[]): Promise<void> {
    const config = await this.getImapConfig();
    const grouped = await this.resolveGrouped(threadId, messageIds);
    const archiveFolder =
      (await findSpecialFolder(this.accountId, "\\Archive")) ?? "Archive";

    console.log(
      `[imap_] archive thread=${threadId} archiveFolder=${archiveFolder} groups=`,
      [...grouped.entries()].map(([f, u]) => `${f}:${u}`),
    );
    for (const [folder, uids] of grouped) {
      if (folder === archiveFolder) continue;
      await imapMoveMessages(config, folder, uids, archiveFolder);
      console.log(
        `[imap_] archive move ${folder} → ${archiveFolder} uids=${uids} OK`,
      );
    }
  }

  async trash(threadId: string, messageIds: string[]): Promise<void> {
    const config = await this.getImapConfig();
    const grouped = await this.resolveGrouped(threadId, messageIds);
    const trashFolder =
      (await findSpecialFolder(this.accountId, "\\Trash")) ?? "Trash";

    console.log(
      `[imap_] trash thread=${threadId} trashFolder=${trashFolder} groups=`,
      [...grouped.entries()].map(([f, u]) => `${f}:${u}`),
    );
    for (const [folder, uids] of grouped) {
      if (folder === trashFolder) continue;
      await imapMoveMessages(config, folder, uids, trashFolder);
      console.log(
        `[imap_] trash move ${folder} → ${trashFolder} uids=${uids} OK`,
      );
    }
  }

  async permanentDelete(threadId: string, messageIds: string[]): Promise<void> {
    const config = await this.getImapConfig();
    const grouped = await this.resolveGrouped(threadId, messageIds);

    console.log(
      `[imap_] permanentDelete thread=${threadId} groups=`,
      [...grouped.entries()].map(([f, u]) => `${f}:${u}`),
    );

    const { recordDeletedImapUid } = await import("@/services/db/deletedImapUids");
    for (const [folder, uids] of grouped) {
      try {
        await imapDeleteMessages(config, folder, uids);
        console.log(`[imap_] permanentDelete ${folder} uids=${uids} OK`);
      } catch (err) {
        // Stale UIDs from moved messages are silently ignored — only log
        console.warn(
          `[imap_] permanentDelete ${folder} uids=${uids} failed (stale?):`,
          err,
        );
      } finally {
        // Always write tombstone so UIDs are never re-imported, even if IMAP delete failed
        for (const uid of uids) {
          await recordDeletedImapUid(this.accountId, folder, uid).catch(() => {});
        }
      }
    }
  }

  async markRead(
    threadId: string,
    messageIds: string[],
    read: boolean,
  ): Promise<void> {
    const config = await this.getImapConfig();
    const grouped = await this.resolveGrouped(threadId, messageIds);

    console.log(
      `[imap_] markRead thread=${threadId} read=${read} groups=`,
      [...grouped.entries()].map(([f, u]) => `${f}:${u}`),
    );
    for (const [folder, uids] of grouped) {
      await imapSetFlags(config, folder, uids, ["Seen"], read);
      console.log(`[imap_] markRead ${folder} uids=${uids} read=${read} OK`);
    }
  }

  async star(
    threadId: string,
    messageIds: string[],
    starred: boolean,
  ): Promise<void> {
    const config = await this.getImapConfig();
    const grouped = await this.resolveGrouped(threadId, messageIds);

    for (const [folder, uids] of grouped) {
      await imapSetFlags(config, folder, uids, ["Flagged"], starred);
    }
  }

  async spam(
    threadId: string,
    messageIds: string[],
    isSpam: boolean,
  ): Promise<void> {
    const config = await this.getImapConfig();
    const grouped = await this.resolveGrouped(threadId, messageIds);
    const junkFolder =
      (await findSpecialFolder(this.accountId, "\\Junk")) ?? "Junk";
    const destination = isSpam ? junkFolder : "INBOX";

    console.log(
      `[imap_] spam thread=${threadId} isSpam=${isSpam} destination=${destination} groups=`,
      [...grouped.entries()].map(([f, u]) => `${f}:${u}`),
    );
    for (const [folder, uids] of grouped) {
      if (folder === destination) continue;
      await imapMoveMessages(config, folder, uids, destination);
    }
  }

  async moveToFolder(
    threadId: string,
    messageIds: string[],
    folderPath: string,
  ): Promise<void> {
    const config = await this.getImapConfig();
    const grouped = await this.resolveGrouped(threadId, messageIds);

    for (const [folder, uids] of grouped) {
      if (folder === folderPath) continue;
      await imapMoveMessages(config, folder, uids, folderPath);
    }
  }

  async addLabel(threadId: string, labelId: string): Promise<void> {
    // Map Gmail-style system label IDs to IMAP folder paths and perform a move.
    // This is how drag-and-drop "restore from Trash" works: addLabel("INBOX") moves
    // all thread messages from their current folder (e.g. Trash) to the INBOX.
    let targetFolder: string | null = null;
    switch (labelId) {
      case "INBOX":
        targetFolder = "INBOX";
        break;
      case "SENT":
        targetFolder =
          (await findSpecialFolder(this.accountId, "\\Sent")) ?? "Sent";
        break;
      case "TRASH":
        targetFolder =
          (await findSpecialFolder(this.accountId, "\\Trash")) ?? "Trash";
        break;
      case "SPAM":
        targetFolder =
          (await findSpecialFolder(this.accountId, "\\Junk")) ?? "Junk";
        break;
      case "DRAFT":
        targetFolder =
          (await findSpecialFolder(this.accountId, "\\Drafts")) ?? "Drafts";
        break;
      default: {
        // Check if the label is mapped to an IMAP folder (bidirectional mapping feature)
        const { getLabelFolderMapping } = await import("@/services/db/folderLabelMappings");
        const mappedFolder = await getLabelFolderMapping(this.accountId, labelId);
        if (mappedFolder) {
          targetFolder = mappedFolder;
        } else {
          // IMAP has no concept of custom labels
          console.warn(
            `[imap_] addLabel: "${labelId}" — IMAP does not support custom labels`,
          );
          return;
        }
      }
    }
    await this.moveToFolder(threadId, [], targetFolder);
  }

  async removeLabel(threadId: string, labelId: string): Promise<void> {
    // For system label removes (e.g. un-archive → add INBOX) addLabel already moved the
    // messages, so no server action is needed here.
    // For user labels that are mapped to an IMAP folder, move the thread back to INBOX.
    const { getLabelFolderMapping } = await import("@/services/db/folderLabelMappings");
    const mappedFolder = await getLabelFolderMapping(this.accountId, labelId);
    if (mappedFolder) {
      // Only move back if messages are currently in that mapped folder
      await this.moveToFolder(threadId, [], "INBOX");
    } else {
      console.log(
        `[imap_] removeLabel: "${labelId}" on thread ${threadId} — handled by prior addLabel move`,
      );
    }
  }

  // ---- Send/Draft operations ----

  async sendMessage(
    rawBase64Url: string,
    _threadId?: string,
  ): Promise<{ id: string }> {
    const smtpConfig = await this.getSmtpConfig();
    const result = await smtpSendEmail(smtpConfig, rawBase64Url);
    if (!result.success) {
      throw new Error(`SMTP send failed: ${result.message}`);
    }

    // Append to server Sent folder. If we get the real IMAP UID back we can
    // build a stable message ID and save locally — the background sync will
    // upsert on the same ID so it's a no-op (no duplicate).
    // If the server doesn't return a UID (uid=0, DavMail) we still save a
    // placeholder row (NULL imap coords) so the sent message is visible
    // immediately; the delta sync's Filter 2 adopts the real UID/folder into
    // that row by Message-ID instead of inserting a duplicate.
    let messageId = `imap-${this.accountId}-sent-${Date.now()}`;
    let resolvedSentFolder: string | undefined;
    let resolvedUid: number | undefined;
    try {
      const imapConfig = await this.getImapConfig();
      const sentFolder =
        (await findSpecialFolder(this.accountId, "\\Sent")) ?? "Sent";
      const uid = await imapAppendMessage(imapConfig, sentFolder, rawBase64Url, "(\\Seen)");
      if (uid > 0) {
        messageId = `imap-${this.accountId}-${sentFolder}-${uid}`;
        resolvedSentFolder = sentFolder;
        resolvedUid = uid;
        // Save locally with the real IMAP UID so the message appears in Sent
        // immediately and delta sync de-dupes on the same ID.
        try {
          await this.saveSentMessageLocally(rawBase64Url, messageId, _threadId, resolvedSentFolder, resolvedUid);
        } catch (err) {
          console.warn("[IMAP] Failed to save sent message to local DB:", err);
        }
        // Proactively purge any same-UID duplicates that may arise when APPENDUID
        // returns an incorrect UID. Run non-fatally in the background so it does
        // not delay the send response.
        import("../db/messages").then(({ purgeImapDuplicates }) =>
          purgeImapDuplicates(this.accountId).catch(() => {}),
        );
      } else {
        // uid === 0: APPEND succeeded but the server returned no APPENDUID
        // (DavMail/Exchange). Without a local save the sent message stays
        // invisible until the next delta sync — save a placeholder row with
        // NULL imap coords now. Do NOT queue an appendToSent retry: the copy
        // IS on the server, re-appending would duplicate it there. The next
        // delta sync imports the server copy and (via the Rust Filter 2
        // NULL-coords adoption) stamps the real UID/folder onto this row.
        try {
          await this.saveSentMessageLocally(rawBase64Url, messageId, _threadId);
        } catch (saveErr) {
          console.warn("[IMAP] Failed to save placeholder sent message (uid=0):", saveErr);
        }
      }
    } catch (err) {
      console.error(
        "[IMAP] Failed to copy sent message to Sent folder on server:",
        err,
      );
      // The email WAS delivered via SMTP — never leave the user staring at an empty
      // Sent folder (they'd re-send, duplicating the delivery). Save a placeholder
      // row now and queue an appendToSent retry that reconciles it with the real
      // server UID once the APPEND finally goes through.
      try {
        await this.saveSentMessageLocally(rawBase64Url, messageId, _threadId);
      } catch (saveErr) {
        console.error("[IMAP] Failed to save placeholder sent message:", saveErr);
      }
      try {
        const { enqueuePendingOperation } = await import("../db/pendingOperations");
        await enqueuePendingOperation(this.accountId, "appendToSent", _threadId ?? messageId, {
          rawBase64Url,
          threadId: _threadId,
          localMessageId: messageId,
        });
      } catch (queueErr) {
        console.error("[IMAP] Failed to queue appendToSent retry:", queueErr);
      }
    }

    return { id: messageId };
  }

  /**
   * Retry the copy-to-Sent APPEND for an already-delivered message (queued when the
   * APPEND failed during sendMessage). Rewires the placeholder local row to the real
   * server UID so the next delta sync upserts onto the same ID instead of duplicating.
   */
  async appendToSent(
    rawBase64Url: string,
    _threadId?: string,
    localMessageId?: string,
  ): Promise<{ id: string }> {
    const sentFolder = (await findSpecialFolder(this.accountId, "\\Sent")) ?? "Sent";
    const db = await getDb();

    // If the original APPEND actually landed server-side (we only saw a client error),
    // delta sync has since imported the real row. Drop the placeholder and do NOT
    // append again — that would put a duplicate copy in the server Sent folder.
    const raw = base64UrlDecode(rawBase64Url);
    const rfcIdMatch = raw.match(/^message-id:\s*<?([^>\r\n]+)>?/im);
    const rfcId = rfcIdMatch?.[1]?.trim() ?? null;
    if (rfcId && localMessageId) {
      const existing = await db.select<{ id: string }[]>(
        `SELECT id FROM messages
         WHERE account_id = $1 AND message_id_header = $2 AND imap_folder = $3 AND id != $4
         LIMIT 1`,
        [this.accountId, rfcId, sentFolder, localMessageId],
      );
      if (existing.length > 0) {
        await db.execute(`DELETE FROM messages WHERE account_id = $1 AND id = $2`, [
          this.accountId,
          localMessageId,
        ]);
        return { id: existing[0]!.id };
      }
    }

    const imapConfig = await this.getImapConfig();
    const uid = await imapAppendMessage(imapConfig, sentFolder, rawBase64Url, "(\\Seen)");
    if (uid > 0 && localMessageId) {
      const realId = `imap-${this.accountId}-${sentFolder}-${uid}`;
      try {
        await db.execute(
          `UPDATE messages SET id = $1, imap_folder = $2, imap_uid = $3
           WHERE account_id = $4 AND id = $5`,
          [realId, sentFolder, uid, this.accountId, localMessageId],
        );
        await db.execute(
          `UPDATE attachments SET message_id = $1 WHERE account_id = $2 AND message_id = $3`,
          [realId, this.accountId, localMessageId],
        );
      } catch {
        // PK collision: delta sync imported the real row concurrently — placeholder
        // is now redundant.
        await db.execute(`DELETE FROM messages WHERE account_id = $1 AND id = $2`, [
          this.accountId,
          localMessageId,
        ]);
      }
      import("../db/messages").then(({ purgeImapDuplicates }) =>
        purgeImapDuplicates(this.accountId).catch(() => {}),
      );
      return { id: realId };
    }
    return { id: localMessageId ?? `imap-${this.accountId}-sent-${Date.now()}` };
  }

  /**
   * Save a sent message to the local SQLite DB with the SENT label.
   * This ensures the message appears in the Sent folder view immediately
   * without waiting for the next IMAP delta sync.
   */
  private async saveSentMessageLocally(
    rawBase64Url: string,
    messageId: string,
    threadId?: string,
    imapFolder?: string,
    imapUid?: number,
  ): Promise<void> {
    const raw = base64UrlDecode(rawBase64Url);
    const headers = parseBasicHeaders(raw);
    const snippet = extractSnippet(raw);

    const from = headers.get("from") ?? "";
    const to = headers.get("to") ?? "";
    const cc = headers.get("cc") ?? null;
    const subject = headers.get("subject") ?? null;
    // Strip angle brackets to match the format stored by Rust's mail-parser during
    // IMAP sync. Otherwise existing_rfc_ids lookups fail and the same message gets
    // re-imported into a new placeholder thread, splitting the conversation.
    // Strip ALL leading/trailing brackets (like Rust's normalize_message_id) —
    // a malformed "<id>>" must collapse to "id", or sync dedup fails on mismatch.
    const stripBrackets = (v: string | null) =>
      v?.trim().replace(/^<+/, "").replace(/>+$/, "").trim() ?? null;
    const messageIdHeader = stripBrackets(headers.get("message-id") ?? null);
    const inReplyTo = stripBrackets(headers.get("in-reply-to") ?? null);
    const references = headers.get("references") ?? null;
    const now = Date.now();

    // For replies, add the SENT label to the existing thread.
    // For new compositions, create a new thread.
    const effectiveThreadId = threadId ?? messageId;

    const rawAttachments = extractRawMimeAttachments(raw);
    const hasAttachments = rawAttachments.some((a) => !a.isInline);

    if (!threadId) {
      // New thread: create thread record + SENT label
      await upsertThread({
        id: effectiveThreadId,
        accountId: this.accountId,
        subject,
        snippet,
        lastMessageAt: now,
        messageCount: 1,
        isRead: true,
        isStarred: false,
        isImportant: false,
        hasAttachments,
      });
      await setThreadLabels(this.accountId, effectiveThreadId, ["SENT"]);
    }

    // Extract sender name from "Name <email>" format
    const fromNameMatch = from.match(/^([^<]*)<[^>]+>/);
    const fromName = fromNameMatch ? fromNameMatch[1]!.trim() : null;
    const fromAddress = from.replace(/.*<([^>]+)>.*/, "$1").trim();

    const bodyHtml = extractHtmlBody(raw);

    await upsertMessage({
      id: messageId,
      accountId: this.accountId,
      threadId: effectiveThreadId,
      fromAddress,
      fromName,
      toAddresses: to,
      ccAddresses: cc,
      bccAddresses: null, // BCC is intentionally omitted from stored messages
      replyTo: null,
      subject,
      snippet,
      date: now,
      isRead: true,
      isStarred: false,
      bodyHtml: bodyHtml ? bodyHtml.slice(0, 50000) : null, // Limit stored body size
      bodyText: snippet,
      rawSize: raw.length,
      internalDate: now,
      messageIdHeader,
      referencesHeader: references,
      inReplyToHeader: inReplyTo,
      imapUid: imapUid ?? null,
      imapFolder: imapFolder ?? null,
    });

    // Store attachment metadata so they appear immediately without waiting for delta sync.
    // imap_part_id is derived from the MIME structure and matches what the IMAP server returns.
    for (const att of rawAttachments) {
      await upsertAttachment({
        id: `${messageId}_${att.partId}`,
        messageId,
        accountId: this.accountId,
        filename: att.filename,
        mimeType: att.mimeType,
        size: att.size,
        gmailAttachmentId: null,
        imapPartId: att.partId,
        contentId: att.contentId,
        isInline: att.isInline,
      });
    }

    // upsertMessage ON CONFLICT does not update thread_id. If the background IMAP sync
    // stored the row first with a placeholder thread_id, force the correct assignment.
    const db = await getDb();
    await db.execute(
      "UPDATE messages SET thread_id = $1 WHERE account_id = $2 AND id = $3 AND thread_id != $1",
      [effectiveThreadId, this.accountId, messageId],
    );

    // The background sync may have created a placeholder thread (id = messageId) before
    // saveSentMessageLocally ran. After the UPDATE above the placeholder has no messages;
    // delete it so the user doesn't see an empty orphaned thread in the Sent list.
    await db.execute(
      `DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2
         AND NOT EXISTS (SELECT 1 FROM messages WHERE account_id = $1 AND thread_id = $2)`,
      [this.accountId, messageId],
    );
    await db.execute(
      `DELETE FROM threads WHERE account_id = $1 AND id = $2
         AND NOT EXISTS (SELECT 1 FROM messages WHERE account_id = $1 AND thread_id = $2)`,
      [this.accountId, messageId],
    );

    if (threadId) {
      // Reply: recalculate thread stats and labels from actual messages in DB.
      // This updates lastMessageAt → thread sorts to top of list; recalculates
      // message_count, is_read, and adds both INBOX (original message) and SENT
      // (this reply) so the thread appears in both folder views immediately.
      await recalculateThreadStats(this.accountId, effectiveThreadId);
    }
  }

  /**
   * Save a draft message to the local SQLite DB with the DRAFT label and IMAP UID.
   * This ensures resolveGrouped() always finds the current UID when the user deletes
   * a draft, even before the next delta sync updates the DB from the server.
   */
  private async saveDraftLocally(
    rawBase64Url: string,
    draftId: string,
    imapUid: number,
    imapFolder: string,
    threadId?: string,
  ): Promise<{ threadId: string }> {
    const raw = base64UrlDecode(rawBase64Url);
    const headers = parseBasicHeaders(raw);
    const snippet = extractSnippet(raw);

    const from = headers.get("from") ?? "";
    const to = headers.get("to") ?? "";
    const cc = headers.get("cc") ?? null;
    const subject = headers.get("subject") ?? null;
    // Strip angle brackets to match the format stored by Rust's mail-parser during IMAP sync.
    // Strip ALL leading/trailing brackets (like Rust's normalize_message_id) —
    // a malformed "<id>>" must collapse to "id", or sync dedup fails on mismatch.
    const stripBrackets = (v: string | null) =>
      v?.trim().replace(/^<+/, "").replace(/>+$/, "").trim() ?? null;
    const messageIdHeader = stripBrackets(headers.get("message-id") ?? null);
    const inReplyTo = stripBrackets(headers.get("in-reply-to") ?? null);
    const references = headers.get("references") ?? null;
    const now = Date.now();

    // For draft replies, attach to the existing thread; otherwise use draftId as threadId
    const effectiveThreadId = threadId ?? draftId;

    // Upsert the thread (creates if new, updates subject/snippet if existing)
    await upsertThread({
      id: effectiveThreadId,
      accountId: this.accountId,
      subject,
      snippet,
      lastMessageAt: now,
      messageCount: 1,
      isRead: false,
      isStarred: false,
      isImportant: false,
      hasAttachments: false,
    });

    // Ensure DRAFT label is present without overwriting other labels (e.g. INBOX for replies)
    const existingLabels = await getThreadLabelIds(this.accountId, effectiveThreadId);
    if (!existingLabels.includes("DRAFT")) {
      await setThreadLabels(this.accountId, effectiveThreadId, [...existingLabels, "DRAFT"]);
    }

    const fromNameMatch = from.match(/^([^<]*)<[^>]+>/);
    const fromName = fromNameMatch ? fromNameMatch[1]!.trim() : null;
    const fromAddress = from.replace(/.*<([^>]+)>.*/, "$1").trim();

    const bodyStart = raw.indexOf("\r\n\r\n");
    const bodyHtml = bodyStart !== -1 ? raw.slice(bodyStart + 4) : null;

    await upsertMessage({
      id: draftId,
      accountId: this.accountId,
      threadId: effectiveThreadId,
      fromAddress,
      fromName,
      toAddresses: to,
      ccAddresses: cc,
      bccAddresses: null,
      replyTo: null,
      subject,
      snippet,
      date: now,
      isRead: false,
      isStarred: false,
      bodyHtml: bodyHtml ? bodyHtml.slice(0, 50000) : null,
      bodyText: snippet,
      rawSize: raw.length,
      internalDate: now,
      isDraft: true,
      messageIdHeader,
      referencesHeader: references,
      inReplyToHeader: inReplyTo,
      imapUid,
      imapFolder,
    });

    return { threadId: effectiveThreadId };
  }

  async createDraft(
    rawBase64Url: string,
    _threadId?: string,
  ): Promise<{ draftId: string; threadId?: string }> {
    const config = await this.getImapConfig();
    const draftsFolder =
      (await findSpecialFolder(this.accountId, "\\Drafts")) ?? "Drafts";

    const uid = await imapAppendMessage(
      config,
      draftsFolder,
      rawBase64Url,
      "(\\Draft)",
    );

    // Build a real UID-based ID so deleteDraft can find and remove it from IMAP
    const draftId = `imap-${this.accountId}-${draftsFolder}-${uid}`;

    // Write to local DB immediately so resolveGrouped() can delete by UID before the next sync
    try {
      const { threadId } = await this.saveDraftLocally(rawBase64Url, draftId, uid, draftsFolder, _threadId);
      return { draftId, threadId };
    } catch (err) {
      console.warn("[IMAP] Failed to save draft to local DB:", err);
      return { draftId };
    }
  }

  async updateDraft(
    draftId: string,
    rawBase64Url: string,
    _threadId?: string,
  ): Promise<{ draftId: string; threadId?: string }> {
    if (draftId.startsWith("imap-draft-")) {
      // Pseudo-ID: no server UID to delete. Create a fresh draft on server + DB.
      return this.createDraft(rawBase64Url, _threadId);
    }

    // Real UID-based ID: append new FIRST (so the new UID is in DB before we remove the old one),
    // then delete the old from server. The old DB record is cleaned up by cleanupOldDraftFromDb
    // in draftAutoSave.ts after this call returns.
    const config = await this.getImapConfig();
    const draftsFolder =
      (await findSpecialFolder(this.accountId, "\\Drafts")) ?? "Drafts";

    const newUid = await imapAppendMessage(config, draftsFolder, rawBase64Url, "(\\Draft)");
    const newDraftId = `imap-${this.accountId}-${draftsFolder}-${newUid}`;

    let returnedThreadId = _threadId;
    try {
      const { threadId } = await this.saveDraftLocally(rawBase64Url, newDraftId, newUid, draftsFolder, _threadId);
      returnedThreadId = threadId;
    } catch (err) {
      console.warn("[IMAP] Failed to save updated draft to local DB:", err);
    }

    // Delete old from server (non-fatal if already gone).
    // Always record a tombstone so the old UID is never re-imported even if the
    // EXPUNGE command fails mid-way (e.g. network drop after +FLAGS \Deleted).
    const { folder: oldFolder, uid: oldUid } = this.parseImapMessageId(draftId);
    try {
      await this.deleteDraft(draftId);
    } catch {
      // Old draft may already be gone or EXPUNGE failed. Record tombstone as fallback
      // so the UID is not re-imported on the next delta sync.
      if (oldUid !== null && oldFolder) {
        const { recordDeletedImapUid } = await import("@/services/db/deletedImapUids");
        await recordDeletedImapUid(this.accountId, oldFolder, oldUid).catch(() => {});
      }
    }

    return { draftId: newDraftId, threadId: returnedThreadId };
  }

  async deleteDraft(draftId: string, _threadId?: string): Promise<void> {
    // Draft IDs from IMAP are in message ID format: imap-{accountId}-{folder}-{uid}
    const { folder, uid } = this.parseImapMessageId(draftId);

    if (uid !== null && folder) {
      const { recordDeletedImapUid } = await import("@/services/db/deletedImapUids");
      // Write tombstone FIRST — SQLite write completes in < 50ms, well before
      // the composer WebView is destroyed. This guarantees the draft is never
      // re-imported even if the subsequent IMAP delete is killed mid-flight.
      await recordDeletedImapUid(this.accountId, folder, uid).catch(() => {});
      // Kill-list by Message-ID: if the server renumbered this copy's UID
      // (DavMail/Exchange do this after APPEND), the tombstone + EXPUNGE below
      // target the wrong UID and the copy resurfaces on the next sync as a
      // phantom draft. The sweep removes it by Message-ID at its current UID.
      try {
        const killList = await import("@/services/db/draftKillList");
        let msgId = killList.getAppendedDraftMsgId(draftId);
        if (!msgId) {
          const db = await getDb();
          const rows = await db.select<{ message_id_header: string | null }[]>(
            "SELECT message_id_header FROM messages WHERE account_id = $1 AND id = $2",
            [this.accountId, draftId],
          );
          msgId = rows[0]?.message_id_header ?? null;
        }
        await killList.recordDraftKill(this.accountId, msgId);
      } catch (err) {
        console.warn("[IMAP] deleteDraft kill-list record failed:", err);
      }
      // IMAP delete is best-effort — may be killed if window dies before it completes,
      // but the tombstone above already prevents re-import.
      const config = await this.getImapConfig();
      await imapDeleteMessages(config, folder, [uid]).catch(() => {});
    } else {
      // Generated draft IDs (imap-draft-...) can't be mapped back to a server UID
      console.warn(
        `Draft ${draftId} has a generated ID and cannot be deleted from server. ` +
          "It will be cleaned up on next sync.",
      );
    }

    // Always clean up the local DB row immediately. Without this, the is_draft=1
    // row stays visible in the thread (corrupted snippet/count) until purgeGhostDrafts
    // runs on the next maintenance cycle (~10 min).
    try {
      const db = await getDb();
      const rows = await db.select<{ thread_id: string }[]>(
        "SELECT thread_id FROM messages WHERE account_id = $1 AND id = $2",
        [this.accountId, draftId],
      );
      if (rows[0]) {
        const threadId = rows[0].thread_id;
        await db.execute(
          "DELETE FROM messages WHERE account_id = $1 AND id = $2",
          [this.accountId, draftId],
        );
        // Remove DRAFT label only if no other draft messages remain in the thread
        const remaining = await db.select<{ cnt: number }[]>(
          "SELECT COUNT(*) as cnt FROM messages WHERE account_id = $1 AND thread_id = $2 AND is_draft = 1",
          [this.accountId, threadId],
        );
        if ((remaining[0]?.cnt ?? 0) === 0) {
          await db.execute(
            "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = 'DRAFT'",
            [this.accountId, threadId],
          );
        }
        await recalculateThreadStats(this.accountId, threadId);
      }
    } catch (err) {
      console.warn("[IMAP] deleteDraft: failed to clean up local DB row:", err);
    }
  }

  // ---- Connection ----

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      const imapConfig = await this.getImapConfig();
      const imapResult = await imapTestConnection(imapConfig);

      // Also test SMTP connectivity
      try {
        const smtpConfig = await this.getSmtpConfig();
        const smtpResult = await smtpTestConnection(smtpConfig);
        if (!smtpResult.success) {
          return {
            success: false,
            message: `IMAP OK, but SMTP failed: ${smtpResult.message}`,
          };
        }
      } catch (err) {
        return {
          success: false,
          message: `IMAP OK, but SMTP failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      return { success: true, message: `Connected: ${imapResult}` };
    } catch (err) {
      return {
        success: false,
        message: `IMAP connection failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async getProfile(): Promise<{ email: string; name?: string }> {
    const account = await this.getAccount();
    return {
      email: account.email,
      name: account.display_name ?? undefined,
    };
  }

  // ---- Helpers ----

  /**
   * Parse IMAP message IDs and group UIDs by folder.
   * Message ID format: imap-{accountId}-{folder}-{uid}
   * Since accountId can contain hyphens, we strip the known prefix
   * "imap-{this.accountId}-" and then parse the remaining "{folder}-{uid}".
   */
  private groupByFolder(messageIds: string[]): Map<string, number[]> {
    const grouped = new Map<string, number[]>();
    const prefix = `imap-${this.accountId}-`;

    for (const messageId of messageIds) {
      const { folder, uid } = this.parseImapMessageId(messageId, prefix);

      if (uid === null || !folder) {
        console.warn(`Skipping invalid IMAP message ID: ${messageId}`);
        continue;
      }

      const existing = grouped.get(folder);
      if (existing) {
        existing.push(uid);
      } else {
        grouped.set(folder, [uid]);
      }
    }

    return grouped;
  }

  /**
   * Parse an IMAP message ID into folder and uid.
   * Returns { folder, uid } or { folder: null, uid: null } if invalid.
   */
  private parseImapMessageId(
    messageId: string,
    prefix?: string,
  ): { folder: string | null; uid: number | null } {
    const p = prefix ?? `imap-${this.accountId}-`;

    if (!messageId.startsWith(p)) {
      return { folder: null, uid: null };
    }

    // After stripping prefix, remainder is "{folder}-{uid}"
    const remainder = messageId.slice(p.length);
    const lastDash = remainder.lastIndexOf("-");
    if (lastDash === -1) {
      return { folder: null, uid: null };
    }

    const folder = remainder.slice(0, lastDash);
    const uid = parseInt(remainder.slice(lastDash + 1), 10);

    if (!folder || isNaN(uid)) {
      return { folder: null, uid: null };
    }

    return { folder, uid };
  }
}
