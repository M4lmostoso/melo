import { useEffect, useMemo, useRef, useState } from "react";
import type { DbCalendarEvent } from "@/services/db/calendarEvents";
import { chipStyle } from "./calendarColors";
import { layoutDayEvents } from "./calendarLayout";

interface WeekViewProps {
  currentDate: Date;
  events: DbCalendarEvent[];
  colorMap: Record<string, string>;
  onEventClick: (event: DbCalendarEvent) => void;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOUR_HEIGHT = 48; // px — matches h-12

export function WeekView({
  currentDate,
  events,
  colorMap,
  onEventClick,
}: WeekViewProps) {
  const [now, setNow] = useState(() => new Date());
  const [scrollbarWidth, setScrollbarWidth] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setScrollbarWidth(el.offsetWidth - el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const n = new Date();
    const weekStart = new Date(currentDate);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);
    const isCurrentWeek = n >= weekStart && n < weekEnd;
    const startHour = isCurrentWeek ? Math.max(0, n.getHours() - 2) : 8;
    el.scrollTop = startHour * HOUR_HEIGHT;
  }, [currentDate]);

  const days = useMemo(() => {
    const start = new Date(currentDate);
    start.setDate(start.getDate() - start.getDay());
    start.setHours(0, 0, 0, 0);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      return d;
    });
  }, [currentDate]);

  const today = new Date();
  const todayStr = today.toDateString();
  const isCurrentWeek = days.some((d) => d.toDateString() === todayStr);

  const { allDayByDay, weekLayouts } = useMemo(() => {
    const adMap = new Map<number, DbCalendarEvent[]>();
    const layouts: ReturnType<typeof layoutDayEvents>[] = [];

    for (const day of days) {
      const dayStartTs = day.getTime() / 1000;
      const dayEndTs = dayStartTs + 86400;
      const dayKey = day.getDate();

      const allDay: DbCalendarEvent[] = [];
      const timed: DbCalendarEvent[] = [];

      for (const e of events) {
        if (e.start_time >= dayEndTs || e.end_time <= dayStartTs) continue;
        if (e.is_all_day) allDay.push(e);
        else timed.push(e);
      }

      if (allDay.length) adMap.set(dayKey, allDay);
      layouts.push(layoutDayEvents(timed, dayStartTs, HOUR_HEIGHT));
    }

    return { allDayByDay: adMap, weekLayouts: layouts };
  }, [events, days]);

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Day headers */}
      <div
        className="grid grid-cols-[60px_repeat(7,1fr)] border-b border-border-primary shrink-0"
        style={{ paddingRight: scrollbarWidth }}
      >
        <div className="border-r border-border-secondary" />
        {days.map((day, i) => {
          const isToday = day.toDateString() === todayStr;
          return (
            <div
              key={i}
              className={`px-2 py-2 text-center border-r border-border-secondary ${
                isToday ? "bg-black/[0.04] dark:bg-black/[0.2]" : ""
              }`}
            >
              <div className="text-xs text-text-tertiary">
                {DAY_NAMES[day.getDay()]}
              </div>
              <div
                className={`text-sm font-medium mt-0.5 w-7 h-7 flex items-center justify-center mx-auto rounded-full ${
                  isToday ? "bg-accent text-white" : "text-text-primary"
                }`}
              >
                {day.getDate()}
              </div>
            </div>
          );
        })}
      </div>

      {/* All-day events row (unchanged style) */}
      <div
        className="grid grid-cols-[60px_repeat(7,1fr)] border-b border-border-primary shrink-0"
        style={{ paddingRight: scrollbarWidth }}
      >
        <div className="border-r border-border-secondary px-1 py-1 text-[0.625rem] text-text-tertiary">
          all-day
        </div>
        {days.map((day, i) => {
          const isToday = day.toDateString() === todayStr;
          const allDay = allDayByDay.get(day.getDate()) ?? [];
          return (
            <div
              key={i}
              className={`border-r border-border-secondary px-1 py-1 space-y-0.5 ${
                isToday ? "bg-black/[0.04] dark:bg-black/[0.2]" : ""
              }`}
            >
              {allDay.map((e) => {
                const color = e.calendar_id
                  ? colorMap[e.calendar_id]
                  : undefined;
                return (
                  <button
                    key={e.id}
                    onClick={() => onEventClick(e)}
                    className={`block w-[calc(100%-8px)] mx-1 text-left text-[0.625rem] px-1 py-0.5 rounded truncate transition-opacity hover:opacity-80 ${
                      color ? "" : "bg-accent/10 text-accent"
                    }`}
                    style={color ? chipStyle(color) : undefined}
                  >
                    {e.summary ?? "Event"}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Time grid */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="flex relative" style={{ height: 24 * HOUR_HEIGHT }}>
          {/* Hour labels */}
          <div className="w-[60px] shrink-0">
            {HOURS.map((hour) => (
              <div
                key={hour}
                className="border-r border-b border-border-secondary flex items-start justify-end px-1"
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

          {/* One column per day */}
          {days.map((day, di) => {
            const dayStartTs = day.getTime() / 1000;
            const layout = weekLayouts[di] ?? [];
            const isDayToday = day.toDateString() === todayStr;

            return (
              <div
                key={di}
                className={`flex-1 relative border-r border-border-secondary ${
                  isDayToday ? "bg-black/[0.04] dark:bg-black/[0.2]" : ""
                }`}
                style={{ height: 24 * HOUR_HEIGHT }}
              >
                {/* Hour lines */}
                {HOURS.map((hour) => (
                  <div
                    key={hour}
                    className="absolute left-0 right-0 border-b border-border-secondary pointer-events-none"
                    style={{ top: hour * HOUR_HEIGHT, height: HOUR_HEIGHT }}
                  />
                ))}

                {/* Positioned timed events */}
                {layout.map(({ event, colIndex, colCount, top, height }) => {
                  const color = event.calendar_id
                    ? colorMap[event.calendar_id]
                    : undefined;
                  const clampedStart = Math.max(event.start_time, dayStartTs);
                  const clampedEnd = Math.min(
                    event.end_time,
                    dayStartTs + 86400,
                  );
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
                      title={`${event.summary ?? "Event"} · ${timeStr}`}
                    >
                      <div className="px-1 py-0.5 h-full flex flex-col overflow-hidden">
                        <span className="text-[0.625rem] font-semibold leading-tight truncate">
                          {event.summary ?? "Event"}
                        </span>
                        {height >= 32 && (
                          <span className="text-[0.5rem] opacity-75 leading-tight truncate mt-0.5">
                            {timeStr}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            );
          })}

          {/* Time indicator — spans all day columns */}
          {isCurrentWeek &&
            (() => {
              const topPx =
                ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_HEIGHT;
              return (
                <div
                  className="absolute z-10 pointer-events-none"
                  style={{ top: topPx, left: 60, right: 0, willChange: "top" }}
                >
                  <div
                    className="absolute w-2.5 h-2.5 rounded-full bg-accent"
                    style={{ left: -5, transform: "translateY(-50%)" }}
                  />
                  <div className="h-px bg-accent" />
                </div>
              );
            })()}
        </div>
      </div>
    </div>
  );
}
