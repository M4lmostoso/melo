import type { Label } from "@/stores/labelStore";

interface LabelBreadcrumbProps {
  label: Label;
  /** Border/accent color for the leaf segment — typically the account color. */
  accountColor?: string | null;
  /** Called when the leaf (last) segment is clicked. */
  onLeafClick: () => void;
  /**
   * Called when a parent (non-leaf) segment is clicked.
   * Receives the full path prefix up to and including that segment.
   * When undefined, parent segments are rendered as non-clickable spans.
   */
  onParentClick?: (prefix: string) => void;
  /** Whether the leaf is the currently active selection. */
  isLeafActive?: boolean;
  /**
   * When true: no wrapping, parent chips are shrink-0, leaf text truncates
   * with ellipsis but never below 50% of its character count (via ch units).
   */
  truncateLeaf?: boolean;
}

export function LabelBreadcrumb({
  label,
  accountColor,
  onLeafClick,
  onParentClick,
  isLeafActive,
  truncateLeaf = false,
}: LabelBreadcrumbProps) {
  const segments = label.name.split("/");

  return (
    <span
      className={`flex items-center gap-0.5 min-w-0 ${
        truncateLeaf ? "flex-nowrap overflow-hidden" : "flex-wrap"
      }`}
    >
      {segments.map((segment, i) => {
        const isLeaf = i === segments.length - 1;
        const prefix = segments.slice(0, i + 1).join("/");

        if (isLeaf) {
          const borderStyle = accountColor ? { borderColor: accountColor } : undefined;
          const minWidthStyle = truncateLeaf
            ? { minWidth: `${Math.ceil(segment.length * 0.5)}ch` }
            : undefined;

          return (
            <button
              key={i}
              onClick={(e) => {
                e.stopPropagation();
                onLeafClick();
              }}
              className={`inline-flex items-center px-1.5 py-0.5 rounded border text-xs font-medium transition-colors ${
                truncateLeaf ? "min-w-0 shrink overflow-hidden" : ""
              } ${
                isLeafActive
                  ? "bg-accent/10 text-accent border-accent"
                  : "text-text-primary hover:bg-bg-hover"
              }`}
              style={!isLeafActive ? { ...borderStyle, ...minWidthStyle } : minWidthStyle}
            >
              <span className={truncateLeaf ? "truncate" : undefined}>{segment}</span>
            </button>
          );
        }

        if (onParentClick) {
          return (
            <button
              key={i}
              onClick={(e) => {
                e.stopPropagation();
                onParentClick(prefix);
              }}
              className={`inline-flex items-center px-1.5 py-0.5 rounded border border-border-primary/40 text-xs text-text-tertiary hover:text-text-secondary hover:border-border-primary transition-colors ${
                truncateLeaf ? "shrink-0" : ""
              }`}
            >
              {segment}
            </button>
          );
        }

        return (
          <span
            key={i}
            className={`inline-flex items-center px-1.5 py-0.5 rounded border border-border-primary/40 text-xs text-text-tertiary cursor-default ${
              truncateLeaf ? "shrink-0" : ""
            }`}
          >
            {segment}
          </span>
        );
      })}
    </span>
  );
}
