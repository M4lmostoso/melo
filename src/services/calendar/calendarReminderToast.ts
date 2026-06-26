/**
 * In-app calendar reminder bridge.
 *
 * OS notifications on macOS are unreliable for our needs: with the "Banners"
 * notification style they auto-dismiss and never show action buttons, and the
 * style is a per-app system setting we can't control. To guarantee a reminder
 * that stays until the user dismisses it and always offers a "Join" button, the
 * reminder checker also emits through this bridge to an in-app toast we fully
 * control (see CalendarReminderToast).
 *
 * Delivery uses a window CustomEvent (the project's `melo-*` cross-component
 * convention) rather than a module-level callback singleton: a singleton can be
 * split into two instances by Vite HMR (emitter and listener ending up on
 * different module copies), silently dropping the event. The single `window`
 * object is immune to that.
 */
export interface CalendarReminder {
  /** Stable id (the calendar event id) so the toast can de-duplicate. */
  id: string;
  summary: string;
  meetingUrl: string | null;
  /** Event start, unix seconds — drives the time chip and live countdown. */
  startTime: number;
}

export const CALENDAR_REMINDER_EVENT = "melo-calendar-reminder";

/** Emit a reminder to the in-app toast, if one is mounted. */
export function emitCalendarReminder(reminder: CalendarReminder): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CALENDAR_REMINDER_EVENT, { detail: reminder }));
}
