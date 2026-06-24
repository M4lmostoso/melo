/**
 * In-app calendar reminder bridge.
 *
 * OS notifications on macOS are unreliable for our needs: with the "Banners"
 * notification style they auto-dismiss and never show action buttons, and the
 * style is a per-app system setting we can't control. To guarantee a reminder
 * that stays until the user dismisses it and always offers a "Join" button, the
 * reminder checker also emits through this bridge to an in-app toast we fully
 * control (see CalendarReminderToast).
 */
export interface CalendarReminder {
  /** Stable id (the calendar event id) so the toast can de-duplicate. */
  id: string;
  summary: string;
  meetingUrl: string | null;
}

type Callback = (reminder: CalendarReminder) => void;

let callback: Callback | null = null;

/** Register the toast's handler. Pass null on unmount. */
export function setCalendarReminderCallback(cb: Callback | null): void {
  callback = cb;
}

/** Emit a reminder to the in-app toast, if one is mounted. */
export function emitCalendarReminder(reminder: CalendarReminder): void {
  callback?.(reminder);
}
