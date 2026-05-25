import { useMemo, useRef, useEffect, useState } from "react";
import { t } from "@/i18n";
import type { DbCalendarEvent } from "@/services/db/calendarEvents";

interface DayViewProps {
  currentDate: Date;
  events: DbCalendarEvent[];
  colorMap?: Record<string, string>;
  onEventClick: (event: DbCalendarEvent) => void;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const HOUR_HEIGHT = 56; // h-14 = 3.5rem = 56px

export function DayView({ currentDate, events, colorMap = {}, onEventClick }: DayViewProps) {
  const dayStart = new Date(currentDate);
  dayStart.setHours(0, 0, 0, 0);

  // Pre-bucket events by hour (O(E) instead of O(24×E))
  const { hourEvents: hourEventMap, allDayEvents } = useMemo(() => {
    const hMap = new Map<number, DbCalendarEvent[]>();
    const allDay: DbCalendarEvent[] = [];
    const dayTs = dayStart.getTime() / 1000;

    for (const e of events) {
      if (e.is_all_day) {
        allDay.push(e);
      } else {
        for (const hour of HOURS) {
          const hStart = dayTs + hour * 3600;
          const hEnd = hStart + 3600;
          if (e.start_time < hEnd && e.end_time > hStart) {
            const list = hMap.get(hour);
            if (list) list.push(e);
            else hMap.set(hour, [e]);
          }
        }
      }
    }

    return { hourEvents: hMap, allDayEvents: allDay };
  }, [events, dayStart]);

  const isToday = new Date().toDateString() === currentDate.toDateString();
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
    if (!isToday || !scrollRef.current) return;
    scrollRef.current.scrollTop = Math.max(0, (nowMinutes / 60 - 2) * HOUR_HEIGHT);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isToday]);

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <div ref={scrollRef} className="flex-1 overflow-y-auto">

        {/* Header — sticky */}
        <div className="sticky top-0 z-20 bg-bg-primary px-6 py-3 border-b border-border-primary flex items-center gap-3">
          <div className={`text-2xl font-bold w-10 h-10 flex items-center justify-center rounded-full ${
            isToday ? "bg-accent text-white" : "text-text-primary"
          }`}>
            {currentDate.getDate()}
          </div>
          <div className="text-sm text-text-secondary">
            {currentDate.toLocaleDateString(undefined, { weekday: "long" })}
          </div>
        </div>

        {/* All-day events — sticky below header */}
        {allDayEvents.length > 0 && (
          <div className="sticky top-[64px] z-20 bg-bg-primary px-6 py-2 border-b border-border-secondary space-y-1">
            {allDayEvents.map((e) => {
              const c = colorMap[e.calendar_id ?? ""] ?? "var(--color-accent)";
              return (
                <button
                  key={e.id}
                  onClick={() => onEventClick(e)}
                  className="w-full text-left text-xs px-2 py-1.5 rounded transition-colors hover:opacity-80"
                  style={{ backgroundColor: `${c}1a`, color: c }}
                >
                  {e.summary ?? t("calendar.eventFallback")} · {t("calendar.eventAllDay")}
                </button>
              );
            })}
          </div>
        )}

        {/* Time grid */}
        <div className="relative">
          {HOURS.map((hour) => {
            const hourEvents = hourEventMap.get(hour) ?? [];
            return (
              <div key={hour} className="flex border-b border-border-secondary h-14">
                <div className="w-16 shrink-0 px-2 relative">
                  {hour !== 0 && (
                    <span className="absolute -top-[9px] right-2 text-[0.625rem] text-text-tertiary leading-none">
                      {`${hour % 12 || 12}${hour < 12 ? "am" : "pm"}`}
                    </span>
                  )}
                </div>
                <div className="flex-1 relative px-1">
                  {hourEvents.map((e) => {
                    const c = colorMap[e.calendar_id ?? ""] ?? "var(--color-accent)";
                    return (
                      <button
                        key={e.id}
                        onClick={() => onEventClick(e)}
                        className="w-full text-left text-xs px-2 py-1 rounded truncate transition-colors hover:opacity-80 mb-0.5"
                        style={{ backgroundColor: `${c}26`, color: c }}
                      >
                        {e.summary ?? t("calendar.eventFallback")}
                        {e.location && <span className="opacity-70"> · {e.location}</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* Current time indicator — spans from hour-label gutter to right edge */}
          {isToday && (
            <div
              className="absolute left-16 right-0 pointer-events-none z-10 flex items-center"
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
