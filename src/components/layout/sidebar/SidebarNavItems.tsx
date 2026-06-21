import type React from "react";
import { useDroppable } from "@dnd-kit/core";
import { ChevronDown, ChevronRight, Tag, Pencil } from "lucide-react";
import { t } from "@/i18n";
import { type Label } from "@/stores/labelStore";
import { LabelBreadcrumb } from "@/components/labels/LabelBreadcrumb";

// Presentational drag-&-drop sidebar rows, extracted from Sidebar.tsx. Each is a
// pure props-driven component (droppable target + styling); no Sidebar state.

export function DroppableNavItem({
  id,
  isActive,
  collapsed,
  onClick,
  onContextMenu,
  title,
  children,
}: {
  id: string;
  isActive: boolean;
  collapsed: boolean;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  title?: string;
  children: (isOver: boolean) => React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });

  return (
    <button
      ref={setNodeRef}
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={title}
      className={`flex items-center w-full py-2 text-sm transition-colors press-scale ${collapsed ? "justify-center px-0" : "gap-3 px-3 text-left"
        } ${isOver
          ? "bg-accent/20 ring-1 ring-accent"
          : isActive
            ? "bg-accent/10 text-accent font-medium"
            : "hover:bg-sidebar-hover text-sidebar-text"
        }`}
    >
      {children(isOver)}
    </button>
  );
}

export function DroppableAccountSubItem({
  droppableId,
  onClick,
  isActive,
  isThreadAccount,
  color,
  displayName,
  badge,
  badgeColor,
}: {
  droppableId: string;
  onClick: () => void;
  isActive: boolean;
  isThreadAccount: boolean;
  color: string;
  displayName: string;
  badge?: number;
  badgeColor?: "accent" | "amber";
}) {
  const { setNodeRef, isOver } = useDroppable({ id: droppableId });
  return (
    <div ref={setNodeRef} className="block w-full">
      <button
        onClick={onClick}
        className={`flex items-center gap-2 w-full py-2 pl-6 pr-8 text-left text-[0.8125rem] transition-colors ${
          isOver
            ? "bg-accent/20 border-l-2 border-accent pl-[22px]"
            : isActive
              ? "text-accent font-medium bg-accent/10"
              : isThreadAccount
                ? "text-sidebar-text font-medium bg-sidebar-hover"
                : "text-sidebar-text/80 hover:text-sidebar-text hover:bg-sidebar-hover"
        }`}
      >
        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
        <span className="flex-1 truncate">{displayName}</span>
        {badge != null && badge > 0 && (
          <span className={`text-[0.625rem] px-1.5 min-w-[1.25rem] h-[1.125rem] rounded-full inline-flex items-center justify-center tabular-nums ${
            badgeColor === "amber" ? "bg-amber-500/15 text-amber-500" : "bg-accent/15 text-accent"
          }`}>
            {badge}
          </span>
        )}
      </button>
    </div>
  );
}

export function ExpandableNavItem({
  id,
  label,
  isActive,
  collapsed,
  expanded,
  onNavigate,
  onToggleExpand,
  leftBorderColor,
  dragHighlight,
  children,
}: {
  id: string;
  label?: string;
  isActive: boolean;
  collapsed: boolean;
  expanded: boolean;
  onNavigate: () => void;
  onToggleExpand: () => void;
  leftBorderColor?: string;
  dragHighlight?: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const highlighted = isOver || dragHighlight;

  if (collapsed) {
    return (
      <button
        ref={setNodeRef}
        onClick={onNavigate}
        title={label}
        className={`flex items-center justify-center w-full py-2 text-sm transition-colors press-scale ${
          highlighted
            ? "bg-accent/20 ring-1 ring-accent"
            : isActive
              ? "bg-accent/10 text-accent font-medium"
              : "hover:bg-sidebar-hover text-sidebar-text"
        }`}
      >
        {children}
      </button>
    );
  }

  return (
    <div
      ref={setNodeRef}
      data-section-header={id}
      style={leftBorderColor ? { borderLeft: `3px solid ${leftBorderColor}` } : undefined}
      className={`flex items-center w-full text-sm transition-colors ${
        highlighted
          ? "bg-accent/20 ring-1 ring-accent"
          : isActive
            ? "bg-accent/10 text-accent font-medium"
            : "hover:bg-sidebar-hover text-sidebar-text"
      }`}
    >
      <button
        onClick={onNavigate}
        className="flex items-center gap-3 flex-1 py-2 pl-3 pr-1 text-left text-sm transition-colors press-scale min-w-0"
        style={leftBorderColor ? { paddingLeft: "0.625rem" } : undefined}
      >
        {children}
      </button>
      <button
        onClick={onToggleExpand}
        className="py-2 pr-3 pl-1 text-sidebar-text/40 hover:text-sidebar-text transition-colors shrink-0"
        title={expanded ? t("sidebar.collapseAccounts") : t("sidebar.expandAccounts")}
      >
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
    </div>
  );
}

export function DroppableLabelItem({
  label,
  isActive,
  collapsed,
  onClick,
  onContextMenu,
  onEditClick,
  onPrefixClick,
  unreadCount,
  accountColor,
  droppableId,
}: {
  label: Label;
  isActive: boolean;
  collapsed: boolean;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onEditClick: () => void;
  onPrefixClick: (prefix: string) => void;
  unreadCount?: number;
  accountColor?: string | null;
  droppableId?: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: droppableId ?? label.id });
  const initial = (label.name[0] ?? "?").toUpperCase();

  return (
    <div
      ref={setNodeRef}
      onContextMenu={onContextMenu}
      className={`group flex items-center w-full py-1.5 text-sm transition-colors ${
        collapsed ? "justify-center px-0" : "gap-2 px-3"
      } ${
        isOver
          ? "bg-accent/20 ring-1 ring-accent"
          : isActive
            ? "bg-accent/10 text-accent font-medium"
            : "hover:bg-sidebar-hover text-sidebar-text"
      }`}
    >
      {collapsed ? (
        <button
          onClick={onClick}
          title={label.name}
          className="flex items-center justify-center"
        >
          <span
            className="w-7 h-7 rounded-md flex items-center justify-center text-xs font-semibold shrink-0"
            style={
              label.colorBg
                ? { backgroundColor: label.colorBg, color: label.colorFg ?? "#ffffff" }
                : undefined
            }
          >
            {label.colorBg ? initial : <Tag size={14} />}
          </span>
        </button>
      ) : (
        <>
          {label.colorBg ? (
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: label.colorBg }}
            />
          ) : (
            <Tag size={12} className="shrink-0 text-sidebar-text/50" />
          )}
          <span className="flex-1 min-w-0">
            <LabelBreadcrumb
              label={label}
              accountColor={accountColor ?? label.colorBg}
              onLeafClick={onClick}
              onParentClick={onPrefixClick}
              isLeafActive={isActive}
              truncateLeaf
            />
          </span>
          {unreadCount !== undefined && unreadCount > 0 && (
            <span className="text-[0.625rem] bg-accent/15 text-accent px-1.5 min-w-[1.25rem] h-[1.125rem] rounded-full inline-flex items-center justify-center tabular-nums shrink-0">
              {unreadCount}
            </span>
          )}
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onEditClick();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onEditClick();
              }
            }}
            className="opacity-0 group-hover:opacity-100 p-0.5 text-sidebar-text/40 hover:text-sidebar-text transition-opacity shrink-0"
            title={t("sidebar.editLabel")}
          >
            <Pencil size={12} />
          </span>
        </>
      )}
    </div>
  );
}
