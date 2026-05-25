import { t } from "@/i18n";
import type { DbCalendarEvent } from "@/services/db/calendarEvents";

interface EventCardProps {
  event: DbCalendarEvent;
  compact?: boolean;
  onClick?: () => void;
  color?: string;
}

export function EventCard({ event, compact, onClick, color }: EventCardProps) {
  const startDate = new Date(event.start_time * 1000);
  const timeStr = event.is_all_day
    ? t("calendar.eventAllDay")
    : startDate.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  const accentColor = color ?? "var(--color-accent)";

  if (compact) {
    return (
      <button
        onClick={onClick}
        className="w-full text-left text-[0.625rem] px-1 py-0.5 rounded line-clamp-2 transition-colors hover:opacity-80"
        style={{ backgroundColor: `${accentColor}1a`, color: accentColor }}
        title={event.summary ?? t("calendar.eventFallback")}
      >
        {event.summary ?? t("calendar.eventFallback")}
      </button>
    );
  }

  return (
    <button
      onClick={onClick}
      className="w-full text-left px-3 py-2 rounded-md border border-border-secondary hover:bg-bg-hover transition-colors"
    >
      <div className="flex items-start gap-2">
        <div className="w-1 h-full min-h-[24px] rounded-full shrink-0" style={{ backgroundColor: accentColor }} />
        <div className="min-w-0">
          <div className="text-sm font-medium text-text-primary truncate">
            {event.summary ?? t("calendar.eventNoTitle")}
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
