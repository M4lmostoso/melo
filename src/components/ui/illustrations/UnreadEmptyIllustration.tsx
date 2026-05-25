interface Props {
  size?: number;
  className?: string;
}

export function UnreadEmptyIllustration({ size = 140, className }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 140 140"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Open envelope body */}
      <rect
        x="22"
        y="58"
        width="90"
        height="58"
        rx="6"
        fill="var(--color-bg-tertiary)"
        stroke="var(--color-border-primary)"
        strokeWidth="1.5"
      />
      {/* Open flap (lifted) */}
      <path
        d="M22 64 L67 38 L112 64"
        fill="var(--color-bg-secondary)"
        stroke="var(--color-border-primary)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      {/* Letter peeking out */}
      <rect
        x="38"
        y="62"
        width="58"
        height="46"
        rx="3"
        fill="var(--color-bg-secondary)"
        stroke="var(--color-border-primary)"
        strokeWidth="1"
      />
      {/* Checkmark on letter */}
      <path
        d="M54 83 L63 92 L80 74"
        stroke="var(--color-accent)"
        strokeWidth="2.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Checkmark glow circle */}
      <circle cx="67" cy="83" r="14" fill="var(--color-accent)" opacity="0.08" />
      {/* Sparkles */}
      <circle cx="20" cy="46" r="2.5" fill="var(--color-accent)" opacity="0.35" />
      <circle cx="114" cy="42" r="2" fill="var(--color-accent)" opacity="0.3" />
      <circle cx="16" cy="68" r="1.5" fill="var(--color-accent)" opacity="0.2" />
      <circle cx="122" cy="60" r="1.5" fill="var(--color-accent)" opacity="0.18" />
      <circle cx="108" cy="110" r="2" fill="var(--color-accent)" opacity="0.15" />
    </svg>
  );
}
