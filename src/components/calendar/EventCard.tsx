import type { DbCalendarEvent } from "@/services/db/calendarEvents";
import { chipStyle, accentBarStyle } from "./calendarColors";
import { t } from "@/i18n";

interface EventCardProps {
  event: DbCalendarEvent;
  color?: string | null;
  compact?: boolean;
  onClick?: () => void;
}

export function EventCard({ event, color, compact, onClick }: EventCardProps) {
  const startDate = new Date(event.start_time * 1000);
  const timeStr = event.is_all_day
    ? t("calendar.eventCard.allDay")
    : startDate.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  if (compact) {
    return (
      <button
        onClick={onClick}
        className={`block w-[calc(100%-8px)] mx-1 text-left text-[0.625rem] px-1 py-0.5 rounded line-clamp-2 break-words transition-opacity hover:opacity-80 ${
          color ? "" : "bg-accent/10 text-accent"
        }`}
        style={color ? chipStyle(color) : undefined}
        title={event.summary ?? t("calendar.eventCard.event")}
      >
        {event.summary ?? t("calendar.eventCard.event")}
      </button>
    );
  }

  return (
    <button
      onClick={onClick}
      className="w-full text-left px-3 py-2 rounded-md border border-border-secondary hover:bg-bg-hover transition-colors"
    >
      <div className="flex items-start gap-2">
        <div
          className="w-1 h-full min-h-[24px] rounded-full shrink-0"
          style={color ? accentBarStyle(color) : { backgroundColor: "var(--color-accent)" }}
        />
        <div className="min-w-0">
          <div className="text-sm font-medium text-text-primary truncate">
            {event.summary ?? t("calendar.eventCard.noTitle")}
          </div>
          <div className="text-xs text-text-tertiary mt-0.5">
            {timeStr}
            {event.location && ` · ${event.location}`}
          </div>
        </div>
      </div>
    </button>
  );
}
