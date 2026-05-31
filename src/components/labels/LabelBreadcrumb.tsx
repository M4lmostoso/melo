import type { Label } from "@/stores/labelStore";

interface LabelBreadcrumbProps {
  label: Label;
  /** Border/accent color for the leaf segment — typically the account color. */
  accountColor?: string | null;
  /** Called when the leaf (last) segment is clicked. */
  onLeafClick: () => void;
  /**
   * Called when a parent (non-leaf) segment is clicked.
   * Receives the full path prefix up to and including that segment
   * (e.g. "Personale/Casa" for a label "Personale/Casa/Qualcosa").
   * When undefined, parent segments are rendered as non-clickable spans.
   */
  onParentClick?: (prefix: string) => void;
  /** Whether the leaf is the currently active selection. */
  isLeafActive?: boolean;
}

/**
 * Renders a label name as an inline breadcrumb.
 * Labels without "/" are rendered as a single leaf segment.
 * Labels like "A/B/C" render: [A] / [B] / [C] where A and B are parent
 * segments (dimmed, optional prefix-click) and C is the leaf segment.
 */
export function LabelBreadcrumb({
  label,
  accountColor,
  onLeafClick,
  onParentClick,
  isLeafActive,
}: LabelBreadcrumbProps) {
  const segments = label.name.split("/");

  return (
    <span className="flex items-center gap-0.5 flex-wrap min-w-0">
      {segments.map((segment, i) => {
        const isLeaf = i === segments.length - 1;
        const prefix = segments.slice(0, i + 1).join("/");

        if (isLeaf) {
          const borderStyle = accountColor
            ? { borderColor: accountColor }
            : undefined;
          return (
            <button
              key={i}
              onClick={(e) => {
                e.stopPropagation();
                onLeafClick();
              }}
              className={`inline-flex items-center px-1.5 py-0.5 rounded border text-xs font-medium transition-colors ${
                isLeafActive
                  ? "bg-accent/10 text-accent border-accent"
                  : "text-text-primary hover:bg-bg-hover"
              }`}
              style={!isLeafActive ? borderStyle : undefined}
            >
              {segment}
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
              className="inline-flex items-center px-1.5 py-0.5 rounded border border-border-primary/40 text-xs text-text-tertiary hover:text-text-secondary hover:border-border-primary transition-colors"
            >
              {segment}
            </button>
          );
        }

        return (
          <span
            key={i}
            className="inline-flex items-center px-1.5 py-0.5 rounded border border-border-primary/40 text-xs text-text-tertiary cursor-default"
          >
            {segment}
          </span>
        );
      })}
    </span>
  );
}
