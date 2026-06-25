import { createBackgroundChecker } from "../backgroundCheckers";
import { getUpcomingEventsToNotify, markCalendarEventNotifiedByIdentity } from "../db/calendarEvents";
import { notifyUpcomingCalendarEvent } from "../notifications/notificationManager";
import { emitCalendarReminder } from "./calendarReminderToast";
import { extractMeetingUrl } from "./icalHelper";
import { getCurrentUnixTimestamp } from "@/utils/timestamp";
import { t } from "@/i18n";

// Notify for any not-yet-notified event whose start lies in [now - 2min, now + 6min].
//
// The lead is ~6 min so a reminder lands close to "5 minutes before". The window
// deliberately extends down to (and just past) `now` rather than being a narrow
// [+4,+6] band: an invite synced late (e.g. received 3 min before the meeting) or a
// pass missed while the machine slept would otherwise fall under +4min and never
// notify at all. last_notified_at (per identity) still guarantees a single reminder.
const WINDOW_START_OFFSET = -2 * 60;
const WINDOW_END_OFFSET = 6 * 60;

/** Patterns to detect a conference URL directly in a plain-text location/description field. */
const MEETING_URL_RE =
  /https?:\/\/(?:[^\s"<>]+\.zoom\.us|teams\.microsoft\.com|meet\.google\.com|[^\s"<>]+\.webex\.com|[^\s"<>]+\.gotomeeting\.com)\/[^\s"<>]*/i;

function extractMeetingUrlFromText(text: string | null): string | null {
  if (!text) return null;
  const m = text.match(MEETING_URL_RE);
  return m ? m[0] : null;
}

async function checkUpcomingEvents(): Promise<void> {
  const now = getCurrentUnixTimestamp();
  const events = await getUpcomingEventsToNotify(
    now + WINDOW_START_OFFSET,
    now + WINDOW_END_OFFSET,
  );

  for (const event of events) {
    // Resolve meeting URL: prefer ical_data (most complete), then location, then description.
    let meetingUrl: string | null = null;
    if (event.ical_data) {
      meetingUrl = extractMeetingUrl(event.ical_data);
    }
    if (!meetingUrl) {
      meetingUrl =
        extractMeetingUrlFromText(event.location) ??
        extractMeetingUrlFromText(event.description);
    }

    const summary = event.summary ?? t("calendar.reminder.eventFallback");
    // OS notification (background signal) + in-app toast (guaranteed: stays until
    // dismissed, always shows a Join button — neither is reliable via a macOS banner).
    notifyUpcomingCalendarEvent(summary, meetingUrl);
    emitCalendarReminder({ id: event.id, summary, meetingUrl });
    // Mark all rows for this meeting (CalDAV + email-invite duplicates), not just the
    // single deduped row, so a twin doesn't trigger a second notification next pass.
    await markCalendarEventNotifiedByIdentity(event, now);
  }
}

const checker = createBackgroundChecker("CalendarReminder", checkUpcomingEvents);
export const startCalendarReminderChecker = checker.start;
export const stopCalendarReminderChecker = checker.stop;
