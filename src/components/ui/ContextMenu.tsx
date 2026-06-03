import { useEffect, useRef, useState, useCallback } from "react";
import { useClickOutside } from "@/hooks/useClickOutside";
import { ChevronRight, Check, Search } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
  separator?: boolean;
  searchable?: boolean;
  children?: ContextMenuItem[];
  action?: () => void;
}

interface ContextMenuProps {
  items: ContextMenuItem[];
  position: { x: number; y: number };
  onClose: () => void;
}

export function ContextMenu({ items, position, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [submenuOpenId, setSubmenuOpenId] = useState<string | null>(null);
  const submenuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [adjustedPosition, setAdjustedPosition] = useState(position);
  // Track rects of items that have submenus for positioning
  const itemRectsRef = useRef<Map<string, DOMRect>>(new Map());

  useClickOutside(menuRef, () => {
    // Don't close if click is inside a submenu (which is portalled outside menuRef)
    // The submenu handles its own outside clicks
    if (!submenuOpenId) onClose();
  });

  // Measure and clamp position to viewport
  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;

    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let x = position.x;
    let y = position.y;

    if (x + rect.width > vw) x = vw - rect.width - 4;
    if (y + rect.height > vh) y = vh - rect.height - 4;
    if (x < 4) x = 4;
    if (y < 4) y = 4;

    setAdjustedPosition({ x, y });
  }, [position]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          setFocusedIndex((prev) => {
            let next = prev + 1;
            while (next < items.length && items[next]?.separator) next++;
            return next >= items.length ? prev : next;
          });
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          setFocusedIndex((prev) => {
            let next = prev - 1;
            while (next >= 0 && items[next]?.separator) next--;
            return next < 0 ? prev : next;
          });
          break;
        }
        case "ArrowRight": {
          e.preventDefault();
          const focused = items[focusedIndex];
          if (focused?.children && !focused.disabled) {
            setSubmenuOpenId(focused.id);
          }
          break;
        }
        case "ArrowLeft": {
          e.preventDefault();
          setSubmenuOpenId(null);
          break;
        }
        case "Enter": {
          e.preventDefault();
          const focused = items[focusedIndex];
          if (focused && !focused.disabled && !focused.separator) {
            if (focused.children) {
              setSubmenuOpenId(focused.id);
            } else if (focused.action) {
              focused.action();
              onClose();
            }
          }
          break;
        }
        case "Escape": {
          e.preventDefault();
          e.stopPropagation();
          onClose();
          break;
        }
      }

      // Prevent other handlers from seeing these keys
      if (["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Enter", "Escape"].includes(e.key)) {
        e.stopPropagation();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [items, focusedIndex, onClose]);

  const cancelSubmenuTimer = useCallback(() => {
    if (submenuTimerRef.current) {
      clearTimeout(submenuTimerRef.current);
      submenuTimerRef.current = null;
    }
  }, []);

  const handleMouseEnter = useCallback((index: number, item: ContextMenuItem) => {
    setFocusedIndex(index);
    cancelSubmenuTimer();

    if (item.children && !item.disabled) {
      submenuTimerRef.current = setTimeout(() => {
        setSubmenuOpenId(item.id);
      }, 100);
    } else {
      // Longer delay before closing to allow mouse to travel to submenu
      submenuTimerRef.current = setTimeout(() => {
        setSubmenuOpenId(null);
      }, 300);
    }
  }, [cancelSubmenuTimer]);

  const handleItemClick = useCallback((item: ContextMenuItem) => {
    if (item.disabled || item.separator) return;
    if (item.children) {
      setSubmenuOpenId((prev) => prev === item.id ? null : item.id);
      return;
    }
    item.action?.();
    onClose();
  }, [onClose]);

  // Close submenu when clicking outside both menu and submenu
  useEffect(() => {
    if (!submenuOpenId) return;
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // If click is inside the main menu, let normal handlers deal with it
      if (menuRef.current?.contains(target)) return;
      // If click is inside a submenu portal, let it handle itself
      if ((target as HTMLElement).closest?.("[data-submenu-portal]")) return;
      // Click is outside everything — close all
      onClose();
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [submenuOpenId, onClose]);

  // Clean up timers
  useEffect(() => {
    return () => {
      if (submenuTimerRef.current) clearTimeout(submenuTimerRef.current);
    };
  }, []);

  // Compute submenu anchor position from the parent item's rect
  const openItem = submenuOpenId ? items.find((i) => i.id === submenuOpenId) : null;
  const submenuAnchor = submenuOpenId ? itemRectsRef.current.get(submenuOpenId) : undefined;

  return (
    <>
      <div
        ref={menuRef}
        role="menu"
        className="fixed z-[100] bg-bg-primary border border-border-primary rounded-md shadow-lg py-1 min-w-[200px]"
        style={{ left: adjustedPosition.x, top: adjustedPosition.y }}
      >
        {items.map((item, index) => {
          if (item.separator) {
            return (
              <div
                key={item.id}
                role="separator"
                className="my-1 border-t border-border-secondary"
              />
            );
          }

          const Icon = item.icon;
          const isFocused = focusedIndex === index;
          const hasSubmenu = !!item.children;
          const isSubmenuOpen = submenuOpenId === item.id;

          return (
            <div key={item.id}>
              <button
                role="menuitem"
                ref={(el) => {
                  if (el && hasSubmenu) {
                    itemRectsRef.current.set(item.id, el.getBoundingClientRect());
                  }
                }}
                disabled={item.disabled}
                onClick={() => handleItemClick(item)}
                onMouseEnter={() => handleMouseEnter(index, item)}
                className={`flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left transition-colors ${
                  item.disabled
                    ? "text-text-tertiary cursor-default"
                    : item.danger
                      ? `text-danger ${isFocused || isSubmenuOpen ? "bg-bg-hover" : ""}`
                      : `text-text-primary ${isFocused || isSubmenuOpen ? "bg-bg-hover" : ""}`
                }`}
              >
                {/* Checkmark or icon column */}
                <span className="w-4 h-4 flex items-center justify-center shrink-0">
                  {item.checked != null ? (
                    item.checked ? <Check size={12} /> : null
                  ) : Icon ? (
                    <Icon size={12} />
                  ) : null}
                </span>

                <span className="flex-1">{item.label}</span>

                {hasSubmenu && (
                  <ChevronRight size={12} className="text-text-tertiary shrink-0" />
                )}

                {item.shortcut && !hasSubmenu && (
                  <span className="text-text-tertiary ml-4 shrink-0">
                    {item.shortcut}
                  </span>
                )}
              </button>
            </div>
          );
        })}
      </div>

      {/* Render submenu as a fixed-position sibling to avoid overflow clipping */}
      {openItem?.children && submenuAnchor && (
        <Submenu
          items={openItem.children}
          anchorRect={submenuAnchor}
          onClose={onClose}
          onMouseEnter={cancelSubmenuTimer}
          searchable={openItem.searchable}
        />
      )}
    </>
  );
}

function Submenu({
  items,
  anchorRect,
  onClose,
  onMouseEnter,
  searchable,
}: {
  items: ContextMenuItem[];
  anchorRect: DOMRect;
  onClose: () => void;
  onMouseEnter?: () => void;
  searchable?: boolean;
}) {
  const submenuRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState<{ left: number; top: number }>({
    left: anchorRect.right,
    top: anchorRect.top,
  });

  useEffect(() => {
    const submenu = submenuRef.current;
    if (!submenu) return;

    const submenuRect = submenu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Prefer right side, fall back to left
    let left = anchorRect.right;
    if (left + submenuRect.width > vw) {
      left = anchorRect.left - submenuRect.width;
    }
    if (left < 4) left = 4;

    // Align top with anchor, clamp to viewport
    let top = anchorRect.top;
    if (top + submenuRect.height > vh) {
      top = vh - submenuRect.height - 4;
    }
    if (top < 4) top = 4;

    setPosition({ left, top });
  }, [anchorRect]);

  useEffect(() => {
    if (searchable) searchRef.current?.focus();
  }, [searchable]);

  const lowerQuery = query.toLowerCase();
  const visibleItems = searchable && lowerQuery
    ? items.filter((item) => item.label.toLowerCase().includes(lowerQuery))
    : items;

  return (
    <div
      ref={submenuRef}
      role="menu"
      data-submenu-portal
      className="fixed z-[101] bg-bg-primary border border-border-primary rounded-md shadow-lg py-1 min-w-[200px] max-w-[320px]"
      style={{ left: position.left, top: position.top }}
      onMouseEnter={onMouseEnter}
    >
      {searchable && (
        <div className="px-2 pb-1 pt-0.5">
          <div className="flex items-center gap-1.5 px-2 py-1 bg-bg-secondary rounded border border-border-primary/50 focus-within:border-accent transition-colors">
            <Search size={11} className="text-text-tertiary shrink-0" />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Tab") {
                  e.preventDefault();
                  const items = submenuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not([disabled])');
                  if (items && items.length > 0) {
                    (e.shiftKey ? items[items.length - 1] : items[0]).focus();
                  }
                }
              }}
              placeholder="Cerca…"
              className="flex-1 bg-transparent text-xs text-text-primary outline-none placeholder:text-text-tertiary min-w-0"
              spellCheck={false}
            />
          </div>
        </div>
      )}
      <div className={searchable ? "max-h-52 overflow-y-auto" : undefined}>
      {visibleItems.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              item.action?.();
              // Don't close on label toggle — allow multi-apply
              if (item.checked == null) {
                onClose();
              }
            }}
            onKeyDown={(e) => {
              if (e.key !== "Tab") return;
              e.preventDefault();
              const allItems = Array.from(
                submenuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not([disabled])') ?? []
              );
              const idx = allItems.indexOf(e.currentTarget);
              if (!e.shiftKey) {
                if (idx < allItems.length - 1) allItems[idx + 1].focus();
                else searchRef.current?.focus();
              } else {
                if (idx > 0) allItems[idx - 1].focus();
                else searchRef.current?.focus();
              }
            }}
            className={`flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left transition-colors ${
              item.disabled
                ? "text-text-tertiary cursor-default"
                : "text-text-primary hover:bg-bg-hover"
            }`}
          >
            <span className="w-4 h-4 flex items-center justify-center shrink-0">
              {item.checked != null ? (
                item.checked ? <Check size={12} className="text-accent" /> : null
              ) : Icon ? (
                <Icon size={12} />
              ) : null}
            </span>
            <span className="flex-1 truncate">{item.label}</span>
          </button>
        );
      })}
      </div>
    </div>
  );
}
