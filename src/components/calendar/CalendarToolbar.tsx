import { ChevronLeft, ChevronRight, Plus, CalendarDays } from "lucide-react";
import { t } from "@/i18n";

export type CalendarView = "day" | "week" | "month";

interface CalendarToolbarProps {
  currentDate: Date;
  view: CalendarView;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onViewChange: (view: CalendarView) => void;
  onCreateEvent: () => void;
  onToggleCalendarList?: () => void;
  showCalendarListButton?: boolean;
}

export function CalendarToolbar({
  currentDate,
  view,
  onPrev,
  onNext,
  onToday,
  onViewChange,
  onCreateEvent,
  onToggleCalendarList,
  showCalendarListButton,
}: CalendarToolbarProps) {
  const title = formatTitle(currentDate, view);

  return (
    <div className="flex items-center justify-between px-6 py-3 border-b border-border-primary">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold text-text-primary">{title}</h2>
        <div className="flex items-center gap-1">
          <button
            onClick={onPrev}
            className="p-1.5 text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            onClick={onToday}
            className="px-2.5 py-1 text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
          >
            {t("calendar.today")}
          </button>
          <button
            onClick={onNext}
            className="p-1.5 text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {showCalendarListButton && onToggleCalendarList && (
          <button
            onClick={onToggleCalendarList}
            className="p-1.5 text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
            title={t("calendar.toggleCalendarList")}
          >
            <CalendarDays size={16} />
          </button>
        )}
        <div className="flex bg-bg-tertiary rounded-md p-0.5">
          {(["day", "week", "month"] as CalendarView[]).map((v) => (
            <button
              key={v}
              onClick={() => onViewChange(v)}
              className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
                view === v
                  ? "bg-bg-primary text-text-primary shadow-sm"
                  : "text-text-tertiary hover:text-text-secondary"
              }`}
            >
              {t(`calendar.view${v.charAt(0).toUpperCase()}${v.slice(1)}` as Parameters<typeof t>[0])}
            </button>
          ))}
        </div>
        <button
          onClick={onCreateEvent}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-accent hover:bg-accent-hover rounded-md transition-colors"
        >
          <Plus size={14} />
          {t("calendar.createEvent")}
        </button>
      </div>
    </div>
  );
}

function formatTitle(date: Date, view: CalendarView): string {
  if (view === "month") {
    return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }
  if (view === "week") {
    const start = new Date(date);
    start.setDate(start.getDate() - start.getDay());
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    if (start.getMonth() === end.getMonth()) {
      const base = start.toLocaleDateString(undefined, { month: "long", year: "numeric" });
      return `${base} ${start.getDate()}–${end.getDate()}`;
    }
    const startStr = start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const endStr = end.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    return `${startStr} – ${endStr}`;
  }
  return date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}
