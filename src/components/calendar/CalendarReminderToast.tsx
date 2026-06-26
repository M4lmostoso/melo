import { useEffect, useState, useCallback } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CalendarClock, Clock, Video, X } from "lucide-react";
import { t } from "@/i18n";
import {
  CALENDAR_REMINDER_EVENT,
  type CalendarReminder,
} from "@/services/calendar/calendarReminderToast";

/** Re-render on a coarse interval so the countdown label stays fresh. */
function useNowTick(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function formatTime(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function relativeLabel(startSec: number, nowMs: number): string {
  const mins = Math.ceil((startSec * 1000 - nowMs) / 60_000);
  if (mins <= 0) return t("calendar.reminder.startingNow");
  return t("calendar.reminder.inMinutes", { count: mins });
}

/**
 * Persistent, glanceable in-app reminder for upcoming calendar events. Unlike a
 * macOS banner it stays until dismissed and always offers a "Join" button when the
 * event has a conference URL. Several reminders stack.
 */
export function CalendarReminderToast() {
  const [reminders, setReminders] = useState<CalendarReminder[]>([]);
  const now = useNowTick();

  useEffect(() => {
    const handler = (e: Event) => {
      const reminder = (e as CustomEvent<CalendarReminder>).detail;
      setReminders((prev) =>
        prev.some((r) => r.id === reminder.id) ? prev : [...prev, reminder],
      );
    };
    window.addEventListener(CALENDAR_REMINDER_EVENT, handler);
    return () => window.removeEventListener(CALENDAR_REMINDER_EVENT, handler);
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
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2.5 w-[360px] max-w-[calc(100vw-2rem)]">
      {reminders.map((reminder) => (
        <div
          key={reminder.id}
          role="alert"
          className="relative glass-panel rounded-xl border border-border-primary overflow-hidden animate-[slideInRight_200ms_ease-out,fadeIn_200ms_ease-out]"
        >
          {/* Accent rail */}
          <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-accent" />

          <div className="flex items-start gap-3 p-4 pl-5">
            {/* Icon badge */}
            <div className="flex items-center justify-center w-10 h-10 shrink-0 rounded-lg bg-accent/10 text-accent ring-1 ring-accent/20">
              <CalendarClock size={20} strokeWidth={2} />
            </div>

            <div className="flex-1 min-w-0">
              {/* Header label with a live dot */}
              <div className="flex items-center gap-1.5 mb-1">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                <span className="text-[11px] font-semibold uppercase tracking-wide text-accent">
                  {t("calendar.reminder.label")}
                </span>
              </div>

              {/* Summary */}
              <p className="text-sm font-semibold text-text-primary leading-snug line-clamp-2">
                {reminder.summary}
              </p>

              {/* Time + live countdown */}
              <div className="flex items-center gap-1.5 mt-1 text-xs text-text-secondary">
                <Clock size={12} className="shrink-0" />
                <span className="tabular-nums">{formatTime(reminder.startTime)}</span>
                <span className="text-text-tertiary">·</span>
                <span>{relativeLabel(reminder.startTime, now)}</span>
              </div>

              {/* Join action */}
              {reminder.meetingUrl && (
                <button
                  onClick={() => join(reminder)}
                  className="mt-3 inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-accent hover:bg-accent-hover rounded-lg shadow-sm transition-colors focus:outline-none focus:ring-2 focus:ring-accent/40"
                >
                  <Video size={14} strokeWidth={2.25} />
                  {t("calendar.reminder.join")}
                </button>
              )}
            </div>

            {/* Close */}
            <button
              onClick={() => dismiss(reminder.id)}
              aria-label={t("calendar.reminder.dismiss")}
              title={t("calendar.reminder.dismiss")}
              className="-mt-1 -mr-1 p-1 shrink-0 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
