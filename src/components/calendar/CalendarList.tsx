import { X } from "lucide-react";
import { calColor, calDisplayName, type DbCalendar } from "@/services/db/calendars";
import type { Account } from "@/stores/accountStore";
import { t } from "@/i18n";

interface CalendarListProps {
  calendars: DbCalendar[];
  onVisibilityChange: (calendarId: string, visible: boolean) => void;
  onClose: () => void;
  accounts?: Account[];
}

function CalendarItem({ cal, onVisibilityChange }: { cal: DbCalendar; onVisibilityChange: (id: string, visible: boolean) => void }) {
  return (
    <label
      key={cal.id}
      className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-bg-hover cursor-pointer transition-colors"
    >
      <input
        type="checkbox"
        checked={!!cal.is_visible}
        onChange={(e) => onVisibilityChange(cal.id, e.target.checked)}
        className="sr-only"
      />
      <span
        className={`w-3 h-3 rounded-sm border-2 flex items-center justify-center shrink-0 transition-colors ${
          cal.is_visible
            ? "border-transparent"
            : "border-border-primary bg-transparent"
        }`}
        style={cal.is_visible ? { backgroundColor: calColor(cal) ?? "var(--color-accent)" } : undefined}
      >
        {!!cal.is_visible && (
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
            <path d="M1.5 4L3 5.5L6.5 2" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <span className="text-sm text-text-primary truncate flex-1">
        {calDisplayName(cal)}
      </span>
      {!!cal.is_primary && (
        <span className="text-[0.6rem] text-text-tertiary shrink-0">{t("calendar.list.primary")}</span>
      )}
    </label>
  );
}

export function CalendarList({ calendars, onVisibilityChange, onClose, accounts }: CalendarListProps) {
  const isGrouped = accounts && accounts.length >= 2;

  return (
    <div className="w-56 border-l border-border-primary bg-bg-secondary overflow-y-auto shrink-0 flex flex-col">
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <h3 className="text-xs font-medium text-text-tertiary uppercase tracking-wider">
          {t("calendar.list.calendars")}
        </h3>
        <button
          onClick={onClose}
          className="p-1 text-text-tertiary hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
          title={t("calendar.list.close")}
        >
          <X size={14} />
        </button>
      </div>

      {isGrouped ? (
        <div className="pb-3">
          {accounts.map((account) => {
            const accountCals = calendars.filter((c) => c.account_id === account.id);
            if (accountCals.length === 0) return null;
            return (
              <div key={account.id} className="mb-1">
                <div className="px-4 py-1 text-[0.65rem] font-semibold text-text-tertiary uppercase tracking-wider truncate">
                  {account.label ?? account.email}
                </div>
                <div className="space-y-0.5 px-2">
                  {accountCals.map((cal) => (
                    <CalendarItem key={cal.id} cal={cal} onVisibilityChange={onVisibilityChange} />
                  ))}
                </div>
              </div>
            );
          })}
          {calendars.length === 0 && (
            <p className="px-4 py-2 text-xs text-text-tertiary">{t("calendar.list.noCalendarsFound")}</p>
          )}
        </div>
      ) : (
        <div className="space-y-0.5 px-2 pb-3">
          {calendars.map((cal) => (
            <CalendarItem key={cal.id} cal={cal} onVisibilityChange={onVisibilityChange} />
          ))}
          {calendars.length === 0 && (
            <p className="px-2 py-2 text-xs text-text-tertiary">{t("calendar.list.noCalendarsFound")}</p>
          )}
        </div>
      )}
    </div>
  );
}
