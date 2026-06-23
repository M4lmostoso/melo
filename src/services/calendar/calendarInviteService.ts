import type { DbAttachment } from "../db/attachments";
import type { Account } from "@/stores/accountStore";
import type { CalendarEventData } from "./types";
import { parseVEvent, extractIcsMethod, extractMeetingUrl, generateRsvpReply } from "./icalHelper";
import {
  getCalendarEventByMessageId,
  upsertEmailInviteEvent,
  updateCalendarEventRsvp,
  setEmailInviteServerEvent,
} from "../db/calendarEvents";
import { getCalendarById, getCalendarByRemoteId } from "../db/calendars";
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

/** Build the row payload for upsertEmailInviteEvent from a parsed event. */
function buildInviteRow(
  event: CalendarEventData,
  icsText: string,
  accountId: string,
  messageId: string,
  rsvpStatus: string | null,
) {
  return {
    accountId,
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
    rsvpStatus,
  };
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

  // Auto-register a received invite on the local calendar so it shows up without
  // requiring an RSVP. Idempotent: only inserts when there's no row yet, so an
  // existing 'declined' tombstone (or a prior response) is never resurrected.
  if (method === "REQUEST" && !stored && event.startTime && event.endTime) {
    try {
      await upsertEmailInviteEvent(
        buildInviteRow(event, icsText, attachment.account_id, messageId, null),
      );
    } catch (err) {
      console.warn("[calendarInvite] auto-add on receive failed:", err);
    }
  }

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

  // 2. On DECLINE: remove from the calendar. Delete the server object if we ever
  //    pushed one, then keep a local 'declined' tombstone (hidden from the calendar
  //    view by the rsvp_status filter, and preventing loadInvite from re-adding it).
  if (partstat === "DECLINED") {
    const existing = await getCalendarEventByMessageId(messageId);
    if (existing?.remote_event_id && existing.calendar_id) {
      try {
        if (await hasCalendarSupport(account.id)) {
          const cal = await getCalendarById(existing.calendar_id);
          if (cal) {
            const calProvider = await getCalendarProvider(account.id);
            await calProvider.deleteEvent(cal.remote_id, existing.remote_event_id, existing.etag ?? undefined);
          }
        }
      } catch (err) {
        console.warn("[calendarInvite] failed to delete declined event from server:", err);
      }
    }
    await upsertEmailInviteEvent(buildInviteRow(event, icsText, account.id, messageId, "declined"));
    await setEmailInviteServerEvent(messageId, null, null, null); // clear server coords
    return;
  }

  // 3. On ACCEPT/TENTATIVE: persist locally, then push to the calendar server,
  //    recording the server coordinates so a later decline can delete it.
  await upsertEmailInviteEvent(buildInviteRow(event, icsText, account.id, messageId, partstat.toLowerCase()));

  try {
    const supported = await hasCalendarSupport(account.id);
    if (supported && event.startTime && event.endTime) {
      const calProvider = await getCalendarProvider(account.id);
      const calendars = await calProvider.listCalendars();
      const primaryCalendar = calendars[0];
      if (primaryCalendar) {
        const created = await calProvider.createEvent(primaryCalendar.remoteId, {
          summary: event.summary ?? "Meeting",
          description: event.description ?? undefined,
          location: event.location ?? undefined,
          startTime: new Date(event.startTime * 1000).toISOString(),
          endTime: new Date(event.endTime * 1000).toISOString(),
          isAllDay: event.isAllDay,
        });
        const cal = await getCalendarByRemoteId(account.id, primaryCalendar.remoteId);
        await setEmailInviteServerEvent(messageId, cal?.id ?? null, created.remoteEventId, created.etag);
      }
    }
  } catch (err) {
    // Non-fatal — the RSVP email and local DB row are already done.
    console.warn("[calendarInvite] failed to push accepted event to calendar server:", err);
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
