import { useEffect, useMemo, useRef, useState } from "react";
import type { DbCalendarEvent } from "@/services/db/calendarEvents";
import { chipStyle } from "./calendarColors";
import { layoutDayEvents } from "./calendarLayout";
import { t } from "@/i18n";

interface DayViewProps {
  currentDate: Date;
  events: DbCalendarEvent[];
  colorMap: Record<string, string>;
  onEventClick: (event: DbCalendarEvent) => void;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const HOUR_HEIGHT = 56; // px — matches h-14

export function DayView({ currentDate, events, colorMap, onEventClick }: DayViewProps) {
  const [now, setNow] = useState(() => new Date());
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const isTodayView = new Date().toDateString() === currentDate.toDateString();
    const n = new Date();
    const startHour = isTodayView ? Math.max(0, n.getHours() - 2) : 8;
    el.scrollTop = startHour * HOUR_HEIGHT;
  }, [currentDate]);

  const dayStart = useMemo(() => {
    const d = new Date(currentDate);
    d.setHours(0, 0, 0, 0);
    return d;
  }, [currentDate]);

  const dayStartTs = dayStart.getTime() / 1000;
  const isToday = new Date().toDateString() === currentDate.toDateString();

  const allDayEvents = useMemo(
    () =>
      events.filter(
        (e) => e.is_all_day && e.start_time < dayStartTs + 86400 && e.end_time > dayStartTs,
      ),
    [events, dayStartTs],
  );

  const layout = useMemo(() => {
    const timed = events.filter(
      (e) => !e.is_all_day && e.start_time < dayStartTs + 86400 && e.end_time > dayStartTs,
    );
    return layoutDayEvents(timed, dayStartTs, HOUR_HEIGHT);
  }, [events, dayStartTs]);

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Header */}
      <div className="px-6 py-3 border-b border-border-primary flex items-center gap-3 shrink-0">
        <div
          className={`text-2xl font-bold w-10 h-10 flex items-center justify-center rounded-full ${
            isToday ? "bg-accent text-white" : "text-text-primary"
          }`}
        >
          {currentDate.getDate()}
        </div>
        <div className="text-sm text-text-secondary">
          {currentDate.toLocaleDateString(undefined, { weekday: "long" })}
        </div>
      </div>

      {/* All-day events (unchanged style) */}
      {allDayEvents.length > 0 && (
        <div className="px-6 py-2 border-b border-border-secondary space-y-1">
          {allDayEvents.map((e) => {
            const color = e.calendar_id ? colorMap[e.calendar_id] : undefined;
            return (
              <button
                key={e.id}
                onClick={() => onEventClick(e)}
                className={`block w-[calc(100%-8px)] mx-1 text-left text-xs px-2 py-1.5 rounded transition-opacity hover:opacity-80 ${
                  color ? "" : "bg-accent/10 text-accent"
                }`}
                style={color ? chipStyle(color) : undefined}
              >
                {e.summary ?? t("calendar.eventCard.event")} · {t("calendar.eventCard.allDay")}
              </button>
            );
          })}
        </div>
      )}

      {/* Time grid */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="flex" style={{ height: 24 * HOUR_HEIGHT }}>
          {/* Hour labels */}
          <div className="w-16 shrink-0">
            {HOURS.map((hour) => (
              <div
                key={hour}
                className="border-b border-border-secondary flex items-start justify-end px-2"
                style={{ height: HOUR_HEIGHT }}
              >
                <span className="text-[0.625rem] text-text-tertiary -mt-2">
                  {hour === 0
                    ? ""
                    : `${hour % 12 || 12}${hour < 12 ? "am" : "pm"}`}
                </span>
              </div>
            ))}
          </div>

          {/* Events column */}
          <div className="flex-1 relative border-l border-border-secondary">
            {/* Hour lines */}
            {HOURS.map((hour) => (
              <div
                key={hour}
                className="absolute left-0 right-0 border-b border-border-secondary pointer-events-none"
                style={{ top: hour * HOUR_HEIGHT, height: HOUR_HEIGHT }}
              />
            ))}

            {/* Time indicator */}
            {isToday && (() => {
              const topPx = (now.getHours() * 60 + now.getMinutes()) / 60 * HOUR_HEIGHT;
              return (
                <div
                  className="absolute left-0 right-0 z-10 pointer-events-none"
                  style={{ top: topPx, willChange: "top" }}
                >
                  <div
                    className="absolute w-2.5 h-2.5 rounded-full bg-accent"
                    style={{ left: -5, transform: "translateY(-50%)" }}
                  />
                  <div className="h-px bg-accent" />
                </div>
              );
            })()}

            {/* Positioned timed events */}
            {layout.map(({ event, colIndex, colCount, top, height }) => {
              const color = event.calendar_id ? colorMap[event.calendar_id] : undefined;
              const clampedStart = Math.max(event.start_time, dayStartTs);
              const clampedEnd = Math.min(event.end_time, dayStartTs + 86400);
              const startDate = new Date(clampedStart * 1000);
              const endDate = new Date(clampedEnd * 1000);
              const timeStr = `${startDate.toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              })} – ${endDate.toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              })}`;

              return (
                <button
                  key={event.id}
                  onClick={() => onEventClick(event)}
                  className={`absolute text-left rounded overflow-hidden transition-opacity hover:opacity-90 ${
                    color ? "" : "bg-accent/15 text-accent"
                  }`}
                  style={{
                    top,
                    height,
                    left: `calc(${(colIndex / colCount) * 100}% + 2px)`,
                    width: `calc(${(1 / colCount) * 100}% - 4px)`,
                    ...(color ? chipStyle(color) : {}),
                  }}
                  title={`${event.summary ?? t("calendar.eventCard.event")} · ${timeStr}`}
                >
                  <div className="px-1.5 py-0.5 h-full flex flex-col overflow-hidden">
                    <span className="text-xs font-semibold leading-tight truncate">
                      {event.summary ?? t("calendar.eventCard.event")}
                    </span>
                    {height >= 36 && (
                      <span className="text-[0.625rem] opacity-75 leading-tight truncate mt-0.5">
                        {timeStr}
                      </span>
                    )}
                    {event.location && height >= 52 && (
                      <span className="text-[0.625rem] opacity-70 leading-tight truncate">
                        {event.location}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
