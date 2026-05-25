import { useMemo, useRef, useEffect, useState } from "react";
import { t } from "@/i18n";
import type { DbCalendarEvent } from "@/services/db/calendarEvents";

interface WeekViewProps {
  currentDate: Date;
  events: DbCalendarEvent[];
  colorMap?: Record<string, string>;
  onEventClick: (event: DbCalendarEvent) => void;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const HOUR_HEIGHT = 48; // h-12 = 3rem = 48px
const DAY_NAMES = Array.from({ length: 7 }, (_, i) =>
  new Date(2023, 0, i + 1).toLocaleDateString(undefined, { weekday: "short" }),
);

export function WeekView({ currentDate, events, colorMap = {}, onEventClick }: WeekViewProps) {
  const weekStart = new Date(currentDate);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  weekStart.setHours(0, 0, 0, 0);

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return d;
  });

  const today = new Date();
  const todayStr = today.toDateString();
  const isCurrentWeek = days.some((d) => d.toDateString() === todayStr);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [nowMinutes, setNowMinutes] = useState(() => {
    const n = new Date();
    return n.getHours() * 60 + n.getMinutes();
  });

  useEffect(() => {
    const interval = setInterval(() => {
      const n = new Date();
      setNowMinutes(n.getHours() * 60 + n.getMinutes());
    }, 60_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!isCurrentWeek || !scrollRef.current) return;
    scrollRef.current.scrollTop = Math.max(0, (nowMinutes / 60 - 2) * HOUR_HEIGHT);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCurrentWeek]);

  // Pre-bucket events by day+hour and all-day per day (O(E) instead of O(168×E))
  const { dayHourEvents, allDayByDay } = useMemo(() => {
    const dhMap = new Map<string, DbCalendarEvent[]>();
    const adMap = new Map<number, DbCalendarEvent[]>();

    for (const day of days) {
      const dayTs = day.getTime() / 1000;
      const dayKey = day.getDate();

      for (const e of events) {
        if (e.is_all_day) {
          const dayEnd = dayTs + 86400;
          if (e.start_time < dayEnd && e.end_time > dayTs) {
            const list = adMap.get(dayKey);
            if (list) list.push(e);
            else adMap.set(dayKey, [e]);
          }
        } else {
          for (const hour of HOURS) {
            const hStart = dayTs + hour * 3600;
            const hEnd = hStart + 3600;
            if (e.start_time < hEnd && e.end_time > hStart) {
              const key = `${dayKey}-${hour}`;
              const list = dhMap.get(key);
              if (list) list.push(e);
              else dhMap.set(key, [e]);
            }
          }
        }
      }
    }

    return { dayHourEvents: dhMap, allDayByDay: adMap };
  }, [events, days]);

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Sticky day headers + all-day row sit inside a single scroll container
          so the scrollbar width never misaligns headers with the time grid */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">

        {/* Day headers — sticky */}
        <div className="sticky top-0 z-20 bg-bg-primary grid grid-cols-[60px_repeat(7,1fr)] border-b border-border-primary">
          <div className="border-r border-border-secondary" />
          {days.map((day, i) => {
            const isToday = day.toDateString() === todayStr;
            return (
              <div key={i} className="px-2 py-2 text-center border-r border-border-secondary">
                <div className="text-xs text-text-tertiary">{DAY_NAMES[day.getDay()]}</div>
                <div className={`text-sm font-medium mt-0.5 w-7 h-7 flex items-center justify-center mx-auto rounded-full ${isToday ? "bg-accent text-white" : "text-text-primary"
                  }`}>
                  {day.getDate()}
                </div>
              </div>
            );
          })}
        </div>

        {/* All-day events row — sticky below day headers */}
        <div className="sticky top-[52px] z-20 bg-bg-primary grid grid-cols-[60px_repeat(7,1fr)] border-b border-border-primary">
          <div className="border-r border-border-secondary px-1 py-1 text-[0.625rem] text-text-tertiary">{t("calendar.allDayLabel")}</div>
          {days.map((day, i) => {
            const allDay = allDayByDay.get(day.getDate()) ?? [];
            return (
              <div key={i} className="border-r border-border-secondary px-1 py-1 space-y-0.5">
                {allDay.map((e) => {
                  const c = colorMap[e.calendar_id ?? ""] ?? "var(--color-accent)";
                  return (
                    <button
                      key={e.id}
                      onClick={() => onEventClick(e)}
                      className="w-full text-left text-[0.625rem] px-1 py-0.5 rounded truncate transition-colors hover:opacity-80"
                      style={{ backgroundColor: `${c}1a`, color: c }}
                    >
                      {e.summary ?? t("calendar.eventFallback")}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Time grid */}
        <div className="relative">
          <div className="grid grid-cols-[60px_repeat(7,1fr)]">
            {HOURS.map((hour) => (
              <div key={hour} className="contents">
                <div className="border-r border-b border-border-secondary h-12 px-1 relative">
                  {hour !== 0 && (
                    <span className="absolute -top-[9px] right-1 text-[0.625rem] text-text-tertiary leading-none">
                      {`${hour % 12 || 12}${hour < 12 ? "am" : "pm"}`}
                    </span>
                  )}
                </div>
                {days.map((day, di) => {
                  const isColToday = day.toDateString() === todayStr;
                  const hourEvents = dayHourEvents.get(`${day.getDate()}-${hour}`) ?? [];
                  return (
                    <div
                      key={di}
                      className={`border-r border-b border-border-secondary h-12 relative px-0.5 ${isColToday ? "bg-black/[0.06] dark:bg-black/[0.15]" : ""
                        }`}
                    >
                      {hourEvents.map((e) => {
                        const c = colorMap[e.calendar_id ?? ""] ?? "var(--color-accent)";
                        return (
                          <button
                            key={e.id}
                            onClick={() => onEventClick(e)}
                            className="absolute inset-x-0.5 text-[0.625rem] px-1 py-0.5 rounded truncate transition-colors hover:opacity-80"
                            style={{ backgroundColor: `${c}26`, color: c }}
                            title={e.summary ?? t("calendar.eventFallback")}
                          >
                            {e.summary ?? t("calendar.eventFallback")}
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          {/* Current time indicator — spans the full width of the time grid */}
          {isCurrentWeek && (
            <div
              className="absolute left-[60px] right-0 pointer-events-none z-10 flex items-center"
              style={{ top: `${(nowMinutes / 60) * HOUR_HEIGHT}px` }}
            >
              <div className="w-2 h-2 rounded-full bg-accent -ml-1 shrink-0" />
              <div className="flex-1 h-px bg-accent" />
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
