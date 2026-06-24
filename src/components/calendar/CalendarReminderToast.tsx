import { useEffect, useState, useCallback } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CalendarClock, Video, X } from "lucide-react";
import { t } from "@/i18n";
import {
  setCalendarReminderCallback,
  type CalendarReminder,
} from "@/services/calendar/calendarReminderToast";

/**
 * Persistent in-app reminder for upcoming calendar events. Unlike a macOS banner,
 * it stays on screen until the user dismisses it and always offers a "Join" button
 * when the event has a conference URL. Several reminders can stack.
 */
export function CalendarReminderToast() {
  const [reminders, setReminders] = useState<CalendarReminder[]>([]);

  useEffect(() => {
    setCalendarReminderCallback((reminder) => {
      setReminders((prev) =>
        prev.some((r) => r.id === reminder.id) ? prev : [...prev, reminder],
      );
    });
    return () => setCalendarReminderCallback(null);
  }, []);

  const dismiss = useCallback((id: string) => {
    setReminders((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const join = useCallback(
    (reminder: CalendarReminder) => {
      if (reminder.meetingUrl) {
        openUrl(reminder.meetingUrl).catch((err) =>
          console.error("Failed to open meeting URL:", err),
        );
      }
      dismiss(reminder.id);
    },
    [dismiss],
  );

  if (reminders.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {reminders.map((reminder) => (
        <div
          key={reminder.id}
          role="alert"
          className="glass-panel rounded-lg shadow-lg overflow-hidden"
        >
          <div className="flex items-start gap-3 px-4 py-3">
            <CalendarClock size={18} className="text-accent shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-text-primary truncate">
                {reminder.summary}
              </p>
              <p className="text-xs text-text-secondary mt-0.5">
                {t("calendar.reminder.startingSoon")}
              </p>
              {reminder.meetingUrl && (
                <button
                  onClick={() => join(reminder)}
                  className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-accent hover:bg-accent-hover rounded-md transition-colors"
                >
                  <Video size={13} />
                  {t("calendar.reminder.join")}
                </button>
              )}
            </div>
            <button
              onClick={() => dismiss(reminder.id)}
              aria-label={t("calendar.reminder.dismiss")}
              title={t("calendar.reminder.dismiss")}
              className="text-text-tertiary hover:text-text-primary transition-colors shrink-0"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
