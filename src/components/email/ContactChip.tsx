import { useState, useRef, useCallback, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useUIStore } from "@/stores/uiStore";
import { t } from "@/i18n";

interface ContactChipProps {
  /** The contact's email address. */
  email: string;
  /** Resolved display name, or null when only the address is known. */
  name: string | null;
  /** The label already rendered in the header (name / from_name / address). */
  children: ReactNode;
}

/**
 * An inline, hoverable contact reference shown in a message header (From/To/Cc).
 * Hover highlights it in the accent color and shows a small card with the
 * contact's name and email (mirrors the search-bar contact suggestion). Clicking
 * opens the contact sidebar focused on this contact.
 *
 * Rendered as a <span> (not a <button>) because it lives inside the message's
 * expand/collapse <button>; the click is stopped from bubbling so it never
 * toggles the message.
 */
export function ContactChip({ email, name, children }: ContactChipProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const displayName = name ?? email;
  const showEmailLine = displayName !== email;

  const show = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - 248));
    setPos({ top: r.bottom + 4, left });
  }, []);

  const hide = useCallback(() => setPos(null), []);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      setPos(null);
      useUIStore.getState().openContactSidebar(email, name);
    },
    [email, name],
  );

  return (
    <>
      <span
        ref={ref}
        role="button"
        tabIndex={0}
        aria-label={t("messageItem.viewContact")}
        onMouseEnter={show}
        onMouseLeave={hide}
        onClick={handleClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") handleClick(e as unknown as React.MouseEvent);
        }}
        className="cursor-pointer rounded-sm hover:text-accent focus:text-accent focus:outline-none transition-colors"
      >
        {children}
      </span>
      {pos &&
        createPortal(
          <div
            style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 100 }}
            className="w-60 flex items-center gap-2.5 px-2.5 py-2 bg-bg-secondary border border-border-primary rounded-lg shadow-lg pointer-events-none"
          >
            <div className="w-7 h-7 rounded-full bg-accent/20 text-accent flex items-center justify-center text-xs font-semibold shrink-0">
              {(displayName[0] ?? "?").toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-text-primary truncate block">
                {displayName}
              </span>
              {showEmailLine && (
                <span className="text-xs text-text-secondary truncate block">{email}</span>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
