import { createBackgroundChecker } from "../backgroundCheckers";
import { getUpcomingEventsToNotify, markCalendarEventNotifiedByIdentity } from "../db/calendarEvents";
import { notifyUpcomingCalendarEvent } from "../notifications/notificationManager";
import { emitCalendarReminder } from "./calendarReminderToast";
import { extractMeetingUrl } from "./icalHelper";
import { getCurrentUnixTimestamp } from "@/utils/timestamp";
import { t } from "@/i18n";

// Notify for events starting in [now + 4min, now + 6min].
// With a 60s checker interval this guarantees a single notification close to 5 min before start.
const WINDOW_START_OFFSET = 4 * 60;
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
