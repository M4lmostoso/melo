import type { DbAttachment } from "../db/attachments";
import type { Account } from "@/stores/accountStore";
import type { CalendarEventData } from "./types";
import { parseVEvent, extractIcsMethod, extractMeetingUrl, generateRsvpReply } from "./icalHelper";
import {
  getCalendarEventByMessageId,
  upsertEmailInviteEvent,
  updateCalendarEventRsvp,
} from "../db/calendarEvents";
import { getEmailProvider } from "../email/providerFactory";
import { hasCalendarSupport, getCalendarProvider } from "./providerFactory";
import { buildRawEmail } from "@/utils/emailBuilder";
import { sendEmail } from "../emailActions";

export type RsvpPartstat = "ACCEPTED" | "DECLINED" | "TENTATIVE";

export interface ParsedInvite {
  event: CalendarEventData;
  method: string;
  meetingUrl: string | null;
  rsvpStatus: string | null;
  icsText: string;
}

/** Fetch ICS attachment content as a UTF-8 string. */
export async function fetchIcsContent(attachment: DbAttachment): Promise<string> {
  const provider = await getEmailProvider(attachment.account_id);
  const attachmentId = attachment.gmail_attachment_id ?? attachment.imap_part_id;
  if (!attachmentId) throw new Error("Attachment has no fetchable ID");
  const { data } = await provider.fetchAttachment(attachment.message_id, attachmentId);
  // data is base64-encoded; decode to UTF-8 text
  const binary = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

/** Parse ICS text, load existing RSVP state from DB, return everything needed by the widget. */
export async function loadInvite(
  attachment: DbAttachment,
  messageId: string,
): Promise<ParsedInvite> {
  const icsText = await fetchIcsContent(attachment);
  const event = parseVEvent(icsText);
  const method = extractIcsMethod(icsText);
  const meetingUrl = extractMeetingUrl(icsText);
  const stored = await getCalendarEventByMessageId(messageId);
  return { event, method, meetingUrl, rsvpStatus: stored?.rsvp_status ?? null, icsText };
}

/**
 * Send RSVP, then (on email success) persist to DB and add event to calendar.
 * Rollback contract: if the RSVP email send fails the DB and calendar are NOT updated,
 * so the stored state always reflects what the organizer was told.
 */
export async function respondToInvite(params: {
  event: CalendarEventData;
  icsText: string;
  messageId: string;
  threadId: string;
  account: Account;
  partstat: RsvpPartstat;
}): Promise<void> {
  const { event, icsText, messageId, threadId, account, partstat } = params;
  const organizerEmail = event.organizerEmail;

  // 1. Send RSVP reply email FIRST — only proceed if this succeeds
  if (organizerEmail) {
    const replyIcs = generateRsvpReply({
      originalIcs: icsText,
      uid: event.uid ?? messageId,
      summary: event.summary ?? "",
      organizerEmail,
      attendeeEmail: account.email,
      attendeeName: account.displayName ?? undefined,
      partstat,
    });

    // Outlook/Teams key the human-readable status off the subject prefix.
    const subjectPrefix = { ACCEPTED: "Accepted", DECLINED: "Declined", TENTATIVE: "Tentative" }[partstat];
    const statusLabel = { ACCEPTED: "accepted", DECLINED: "declined", TENTATIVE: "tentatively accepted" }[partstat];
    const rawEmail = buildRawEmail({
      from: account.email,
      to: [organizerEmail],
      subject: `${subjectPrefix}: ${event.summary ?? "Meeting Invitation"}`,
      htmlBody: `<p>I have ${statusLabel} your invitation.</p>`,
      inReplyTo: messageId,
      threadId,
      attachments: [
        {
          filename: "invite.ics",
          // charset + method are required for Exchange/Teams to auto-process the REPLY.
          mimeType: "text/calendar; charset=UTF-8; method=REPLY",
          content: encodeIcsBase64(replyIcs),
        },
      ],
    });

    // Throws on failure — intentionally stops the rest of the flow
    const result = await sendEmail(account.id, rawEmail, threadId);
    if (!result.success) throw new Error(result.error ?? "Failed to send RSVP email");
  }

  // 2. Persist to DB (email was sent, or no organizer to notify)
  await upsertEmailInviteEvent({
    accountId: account.id,
    sourceMessageId: messageId,
    uid: event.uid ?? messageId,
    recurrenceId: event.recurrenceId ?? null,
    summary: event.summary,
    description: event.description,
    location: event.location,
    startTime: event.startTime,
    endTime: event.endTime,
    isAllDay: event.isAllDay,
    status: event.status,
    organizerEmail: event.organizerEmail,
    attendeesJson: event.attendeesJson,
    icalData: icsText,
    rsvpStatus: partstat.toLowerCase(),
  });

  // 3. Add to calendar (best-effort — DB already updated)
  if (partstat !== "DECLINED") {
    try {
      const supported = await hasCalendarSupport(account.id);
      if (supported && event.startTime && event.endTime) {
        const calProvider = await getCalendarProvider(account.id);
        const calendars = await calProvider.listCalendars();
        const primaryCalendar = calendars[0];
        if (primaryCalendar) {
          await calProvider.createEvent(primaryCalendar.remoteId, {
            summary: event.summary ?? "Meeting",
            description: event.description ?? undefined,
            location: event.location ?? undefined,
            startTime: new Date(event.startTime * 1000).toISOString(),
            endTime: new Date(event.endTime * 1000).toISOString(),
            isAllDay: event.isAllDay,
          });
        }
      }
    } catch {
      // Calendar sync failure is non-fatal — RSVP email and DB are already done
    }
  }
}

/** Update only the RSVP status (for re-responding without re-sending). */
export async function updateRsvp(messageId: string, partstat: RsvpPartstat): Promise<void> {
  await updateCalendarEventRsvp(messageId, partstat.toLowerCase());
}

/** UTF-8-safe base64 — plain btoa() throws on accented chars in summary/CN. */
function encodeIcsBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
