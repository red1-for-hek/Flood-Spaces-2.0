type RiskGaugeProps = {
  score: number;
  level: string;
  size?: number;
  label?: string;
};

const levelStops: Record<string, { from: string; to: string; glow: string }> = {
  low: { from: "#34d399", to: "#22d3ee", glow: "rgba(52, 211, 153, 0.35)" },
  moderate: { from: "#fbbf24", to: "#f59e0b", glow: "rgba(251, 191, 36, 0.35)" },
  high: { from: "#fb923c", to: "#f97316", glow: "rgba(251, 146, 60, 0.35)" },
  severe: { from: "#f87171", to: "#ef4444", glow: "rgba(248, 113, 113, 0.35)" },
  flood: { from: "#ef4444", to: "#b91c1c", glow: "rgba(239, 68, 68, 0.45)" }
};

export default function RiskGauge({ score, level, size = 168, label = "Risk index" }: RiskGaugeProps) {
  const stops = levelStops[level] || levelStops.low;
  const radius = 62;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, score));
  const dash = (clamped / 100) * circumference;
  const gradientId = `gauge-${level}`;

  return (
    <div className="risk-gauge" style={{ width: size, height: size }}>
      <svg viewBox="0 0 168 168" role="img" aria-label={`${label}: ${clamped} out of 100`}>
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={stops.from} />
            <stop offset="100%" stopColor={stops.to} />
          </linearGradient>
          <filter id={`${gradientId}-glow`} x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <circle className="gauge-track" cx="84" cy="84" r={radius} fill="none" strokeWidth="10" />
        <circle
          cx="84"
          cy="84"
          r={radius}
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference}`}
          transform="rotate(-90 84 84)"
          filter={`url(#${gradientId}-glow)`}
          style={{ transition: "stroke-dasharray 700ms cubic-bezier(0.22, 1, 0.36, 1)" }}
        />
      </svg>
      <div className="risk-gauge-center">
        <span className="risk-gauge-value">{Math.round(clamped)}</span>
        <span className="risk-gauge-max">/100</span>
        <span className="risk-gauge-label">{label}</span>
      </div>
    </div>
  );
}
