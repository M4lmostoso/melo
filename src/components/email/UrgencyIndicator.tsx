import { useState, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { Zap, Wind, VolumeX } from "lucide-react";
import { t } from "@/i18n";

interface UrgencyIndicatorProps {
  urgencyScore?: number;
  isMuted?: boolean;
  isHeatExtinguished?: boolean;
  urgencyReason?: string | null;
  urgencyReplyDecayed?: boolean;
}

type UrgencyState = "high" | "moderate" | "resolved" | "muted";

function resolveState(p: UrgencyIndicatorProps): UrgencyState | null {
  const score = p.urgencyScore ?? 0;
  if (p.isMuted) return "muted";
  if (p.isHeatExtinguished && score === 0) return "resolved";
  if (p.isHeatExtinguished) return null;
  if (score >= 0.6) return "high";
  if (score >= 0.3) return "moderate";
  return null;
}

const STATE_META: Record<UrgencyState, { color: string; labelKey: string }> = {
  high: { color: "text-danger", labelKey: "threadCard.highUrgency" },
  moderate: { color: "text-warning", labelKey: "threadCard.moderateUrgency" },
  resolved: { color: "text-success", labelKey: "threadCard.urgencyResolved" },
  muted: { color: "text-text-tertiary", labelKey: "threadCard.mutedUrgency" },
};

/**
 * The thread urgency icon plus a hover card detailing the level, score, the AI's
 * rationale, and whether the score was lowered by a partial (non-closing) reply.
 * Renders nothing when the thread carries no urgency signal.
 */
export function UrgencyIndicator(props: UrgencyIndicatorProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const show = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left - 120, window.innerWidth - 268));
    // Flip above the icon when there isn't room below (cards near the list bottom).
    const ESTIMATED_H = 110;
    const top =
      r.bottom + 6 + ESTIMATED_H > window.innerHeight
        ? Math.max(8, r.top - 6 - ESTIMATED_H)
        : r.bottom + 6;
    setPos({ top, left });
  }, []);

  const hide = useCallback(() => setPos(null), []);

  const state = resolveState(props);
  if (!state) return null;

  const meta = STATE_META[state];
  const score = props.urgencyScore ?? 0;
  const showScore = state === "high" || state === "moderate";
  const reason = props.urgencyReason?.trim();
  const showReason = showScore && !!reason;

  const Icon = state === "muted" ? VolumeX : state === "resolved" ? Wind : Zap;

  return (
    <>
      <span
        ref={ref}
        onMouseEnter={show}
        onMouseLeave={hide}
        className={`shrink-0 ${meta.color}`}
      >
        <Icon size={12} className={state === "high" ? "fill-current" : undefined} />
      </span>
      {pos &&
        createPortal(
          <div
            style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 100 }}
            className="w-64 px-3 py-2.5 bg-bg-secondary border border-border-primary rounded-lg shadow-lg pointer-events-none space-y-1.5"
          >
            <div className={`flex items-center gap-1.5 text-sm font-medium ${meta.color}`}>
              <Icon size={13} className={state === "high" ? "fill-current" : undefined} />
              <span>{t(meta.labelKey)}</span>
            </div>
            {showScore && (
              <div className="text-xs text-text-secondary">
                <span className="text-text-tertiary">{t("urgency.score")}:</span>{" "}
                {Math.round(score * 100)}%
              </div>
            )}
            {showReason && (
              <div className="text-xs text-text-secondary">
                <span className="text-text-tertiary">{t("urgency.reason")}:</span> {reason}
              </div>
            )}
            {props.urgencyReplyDecayed && state !== "resolved" && (
              <div className="text-xs text-accent">{t("urgency.replyDecayed")}</div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
