import { HelpTooltip } from "@/components/help/HelpTooltip";

export function Section({
  title,
  description,
  children,
  action,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-text-primary">{title}</h3>
        {action}
      </div>
      <div className="rounded-xl bg-bg-secondary/60 px-5 py-4 space-y-3">
        {description && (
          <p className="text-xs text-text-tertiary leading-relaxed">{description}</p>
        )}
        {children}
      </div>
    </div>
  );
}

export function SettingRow({
  label,
  children,
  tip,
}: {
  label: string;
  children: React.ReactNode;
  /** Contextual help tip id (from CONTEXTUAL_TIPS) rendered as a ? next to the label. */
  tip?: string;
}) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <label className="flex items-center gap-1.5 text-sm text-text-secondary">
        {label}
        {tip && <HelpTooltip contextId={tip} />}
      </label>
      {children}
    </div>
  );
}

export function ToggleRow({
  label,
  description,
  checked,
  onToggle,
  tip,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onToggle: () => void;
  /** Contextual help tip id (from CONTEXTUAL_TIPS) rendered as a ? next to the label. */
  tip?: string;
}) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <div className="flex-1">
        <span className="inline-flex items-center gap-1.5 text-sm text-text-secondary">
          {label}
          {tip && <HelpTooltip contextId={tip} />}
        </span>
        {description && (
          <p className="text-xs text-text-tertiary mt-0.5">{description}</p>
        )}
      </div>
      <button
        onClick={onToggle}
        className={`w-10 h-5 rounded-full transition-colors relative shrink-0 ml-4 ${
          checked ? "bg-accent" : "bg-bg-tertiary"
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform shadow ${
            checked ? "translate-x-5" : ""
          }`}
        />
      </button>
    </div>
  );
}
