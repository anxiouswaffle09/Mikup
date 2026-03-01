import React, { useState } from 'react';
import type { DiagnosticMetrics } from '../types';
import type { DspFramePayload } from '../types';

interface StatsBarProps {
  metrics: DiagnosticMetrics;
  eventCount: number;
  integratedLufs: number | null;
}

export const StatsBar: React.FC<StatsBarProps> = ({ metrics, eventCount, integratedLufs }) => {
  return (
    <div className="border-t border-b border-panel-border py-4 grid grid-cols-2 md:grid-cols-5 gap-x-6 gap-y-4">
      <StatCell
        label="SNR"
        value={metrics.intelligibility_snr}
        unit="dB"
        min={-10}
        max={40}
        interpret={interpretSnr(metrics.intelligibility_snr)}
        targetLabel="Target > 15 dB"
        targets={[15]}
      />
      <StatCell
        label="Phase Correlation"
        value={metrics.stereo_correlation}
        unit=""
        min={-1}
        max={1}
        interpret={interpretCorr(metrics.stereo_correlation)}
        targetLabel="Target > 0.5"
        targets={[0.5]}
      />
      <StatCell
        label="Stereo Balance"
        value={metrics.stereo_balance}
        unit=""
        min={-1}
        max={1}
        interpret={interpretBalance(metrics.stereo_balance)}
        targetLabel="Target ±0.1"
        targets={[-0.1, 0.1]}
      />
      <StatCell
        label="Events Detected"
        value={eventCount}
        unit=""
        min={0}
        max={100}
        interpret=""
        hideBar
      />
      <StatCell
        label="Integrated LUFS"
        value={integratedLufs ?? 0}
        unit="LUFS"
        min={-48}
        max={0}
        interpret={integratedLufs !== null && integratedLufs !== undefined ? '' : 'N/A'}
        hideBar={integratedLufs === null || integratedLufs === undefined}
        decimals={2}
      />
    </div>
  );
};

interface StatCellProps {
  label: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  interpret: string;
  hideBar?: boolean;
  decimals?: number;
  targets?: number[];
  targetLabel?: string;
}

const StatCell: React.FC<StatCellProps> = ({ label, value, unit, min, max, interpret, hideBar, decimals, targets, targetLabel }) => {
  const pct = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const safeTargets = (targets ?? [])
    .map((target) => Math.max(0, Math.min(1, (target - min) / (max - min))));
  const precision = typeof decimals === 'number' ? decimals : value % 1 === 0 ? 0 : 2;

  return (
    <div className="flex flex-col gap-1">
      <span className="text-[9px] uppercase tracking-widest font-bold text-text-muted">{label}</span>
      <span className="font-mono text-xl font-semibold text-text-main tabular-nums leading-none">
        {typeof value === 'number' ? value.toFixed(precision) : '--'}
        {unit && <span className="text-xs font-normal text-text-muted ml-1">{unit}</span>}
      </span>
      {!hideBar && (
        <div className="h-px w-full bg-panel-border relative mt-1">
          {safeTargets.map((targetPos, index) => (
            <div
              key={`${label}-target-${index}`}
              className="absolute top-[-1px] h-[3px] w-[1px] bg-[oklch(0.65_0.14_20)]"
              style={{ left: `${targetPos * 100}%` }}
            />
          ))}
          <div
            className="absolute top-0 left-0 h-px bg-accent transition-all duration-700"
            style={{ width: `${pct * 100}%` }}
          />
        </div>
      )}
      {interpret && (
        <span className="text-[9px] text-text-muted font-medium mt-0.5">{interpret}</span>
      )}
      {targetLabel && !hideBar && (
        <span className="text-[9px] text-text-muted/80 font-medium">{targetLabel}</span>
      )}
    </div>
  );
};

function interpretSnr(v: number) {
  if (v > 25) return 'Excellent Clarity';
  if (v > 15) return 'Clear Dialogue';
  if (v > 5) return 'Competitive Mix';
  return 'Poor Separation';
}

function interpretCorr(v: number) {
  if (v > 0.8) return 'Strong Mono Compat.';
  if (v > 0.3) return 'Healthy Stereo';
  if (v >= 0) return 'Wide Field';
  return 'Phase Issues';
}

function interpretBalance(v: number) {
  if (Math.abs(v) < 0.1) return 'Centered';
  if (v > 0) return 'Biased Right';
  return 'Biased Left';
}

// ---------------------------------------------------------------------------
// LiveMeters — real-time mode used during stream_audio_metrics streaming
// ---------------------------------------------------------------------------

interface LiveMetersProps {
  frame: DspFramePayload;
  /** Available only after dsp-complete fires. Shows '--' until then. */
  lra?: number;
}

export const LiveMeters: React.FC<LiveMetersProps> = ({ frame, lra }) => {
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-1">
        <span className="text-[9px] uppercase tracking-widest font-bold text-text-muted">SNR</span>
        <SemiCircleGauge value={frame.snr_db} min={0} max={40} />
      </div>
      <StereoHeatbar value={frame.phase_correlation} isPhaseIssue={frame.phase_correlation < 0} label="Phase" />
      <LiveStatCell
        label="True Peak"
        value={frame.dialogue_true_peak_dbtp}
        unit="dBTP"
        min={-24}
        max={0}
        targets={[-1]}
        targetLabel="Ceiling −1 dBTP"
        dangerAbove={-1}
      />
      <div className="flex flex-col gap-1">
        <span className="text-[9px] uppercase tracking-widest font-bold text-text-muted">Centroid</span>
        <span className="font-mono text-xl font-semibold text-text-main tabular-nums leading-none">
          {frame.dialogue_centroid_hz.toFixed(0)}<span className="text-xs font-normal text-text-muted ml-1">Hz</span>
        </span>
        <CentroidNeedle value={frame.dialogue_centroid_hz} />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[9px] uppercase tracking-widest font-bold text-text-muted">LRA</span>
        <span className="font-mono text-xl font-semibold text-text-main tabular-nums leading-none">
          {lra !== undefined ? `${lra.toFixed(1)}` : '--'}
          {lra !== undefined && <span className="text-xs font-normal text-text-muted ml-1">LU</span>}
        </span>
      </div>
      <MaskingIndicator masked={frame.speech_pocket_masked} />
    </div>
  );
};

interface LiveStatCellProps {
  label: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  decimals?: number;
  targets?: number[];
  targetLabel?: string;
  dangerAbove?: number; // if value exceeds this, bar turns red
}

export const LiveStatCell: React.FC<LiveStatCellProps> = ({
  label,
  value,
  unit,
  min,
  max,
  decimals,
  targets,
  targetLabel,
  dangerAbove,
}) => {
  const pct = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const safeTargets = (targets ?? []).map((t) =>
    Math.max(0, Math.min(1, (t - min) / (max - min)))
  );
  const precision = typeof decimals === 'number' ? decimals : 2;
  const inDanger = dangerAbove !== undefined && value > dangerAbove;

  // Peak hold: update during render when value exceeds previous peak.
  // This is the React-approved "adjusting state when a prop changes" pattern —
  // React re-renders immediately with the new peak, skipping a wasted frame.
  const [peak, setPeak] = useState(value);
  if (value > peak) {
    setPeak(value);
  }
  const peakPct = Math.max(0, Math.min(1, (peak - min) / (max - min)));

  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between items-baseline">
        <span className="text-[9px] uppercase tracking-widest font-bold text-text-muted">{label}</span>
        {peak !== value && (
          <span className="text-[8px] font-mono text-text-muted/60 tabular-nums">
            PK {peak.toFixed(precision)}
          </span>
        )}
      </div>
      <span
        className="font-mono text-xl font-semibold tabular-nums leading-none transition-colors duration-150"
        style={{ color: inDanger ? 'oklch(0.65 0.2 25)' : 'var(--color-text-main)' }}
      >
        {value.toFixed(precision)}
        {unit && <span className="text-xs font-normal text-text-muted ml-1">{unit}</span>}
      </span>
      <div className="h-px w-full bg-panel-border relative mt-1">
        {safeTargets.map((pos, i) => (
          <div
            key={i}
            className="absolute top-[-1px] h-[3px] w-[1px] bg-[oklch(0.65_0.14_20)]"
            style={{ left: `${pos * 100}%` }}
          />
        ))}
        {/* Peak indicator */}
        <div
          className="absolute top-[-1px] h-[3px] w-[1px] bg-text-muted/40 transition-all duration-300"
          style={{ left: `${peakPct * 100}%` }}
        />
        <div
          className="absolute top-0 left-0 h-px transition-all duration-150"
          style={{
            width: `${pct * 100}%`,
            backgroundColor: inDanger ? 'oklch(0.65 0.2 25)' : 'var(--color-accent)',
          }}
        />
      </div>
      {targetLabel && (
        <span className="text-[9px] text-text-muted/80 font-medium">{targetLabel}</span>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// SemiCircleGauge — SNR gauge rendered as an animated SVG arc + needle
// ---------------------------------------------------------------------------

interface SemiCircleGaugeProps {
  value: number;   // current value in dB
  min?: number;    // default 0
  max?: number;    // default 40
}

const SemiCircleGauge: React.FC<SemiCircleGaugeProps> = ({ value, min = 0, max = 40 }) => {
  const cx = 60;
  const cy = 60;
  const r = 50;

  // Arc helper: returns SVG path `d` for an arc from angleDeg1 to angleDeg2
  // Angles: 0° = right, 90° = down. We sweep the top half (180° left → 0° right).
  // The full arc goes from 180° to 0° (left to right across the top).
  // We parameterise in terms of fraction of the 180° arc.
  function arcPath(fracStart: number, fracEnd: number): string {
    // fracStart/fracEnd in [0, 1] mapping 0→left (180°) to 1→right (0°)
    const degStart = 180 - fracStart * 180;
    const degEnd = 180 - fracEnd * 180;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const x1 = cx + r * Math.cos(toRad(degStart));
    const y1 = cy - r * Math.sin(toRad(degStart));
    const x2 = cx + r * Math.cos(toRad(degEnd));
    const y2 = cy - r * Math.sin(toRad(degEnd));
    // large-arc-flag: 0 because each segment is < 180°
    return `M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`;
  }

  // Zone fractions over the 0–40 dB range
  // Red:    0–5 dB  → 0.000 – 0.125
  // Yellow: 5–15 dB → 0.125 – 0.375
  // Green:  15–40 dB → 0.375 – 1.000
  const redStart   = 0;
  const redEnd     = (5  - min) / (max - min);
  const yellowEnd  = (15 - min) / (max - min);
  const greenEnd   = 1;

  // Needle angle: 180° (pointing left) at min, 0° (pointing right) at max
  const clampedValue = Math.max(min, Math.min(max, value));
  const needleFrac = (clampedValue - min) / (max - min);
  // Angle in standard math coords (0° = right): 180° – needleFrac*180°
  const needleDeg = 180 - needleFrac * 180;
  const needleRad = (needleDeg * Math.PI) / 180;
  const needleLength = 44;
  const nx = cx + needleLength * Math.cos(needleRad);
  const ny = cy - needleLength * Math.sin(needleRad);

  return (
    <svg width={120} height={65} viewBox="0 0 120 65" aria-label={`SNR ${value.toFixed(1)} dB`}>
      {/* Track arcs */}
      <path
        d={arcPath(redStart, redEnd)}
        fill="none"
        stroke="oklch(0.55 0.22 25)"
        strokeWidth={5}
        strokeLinecap="round"
      />
      <path
        d={arcPath(redEnd, yellowEnd)}
        fill="none"
        stroke="oklch(0.75 0.18 85)"
        strokeWidth={5}
        strokeLinecap="round"
      />
      <path
        d={arcPath(yellowEnd, greenEnd)}
        fill="none"
        stroke="oklch(0.65 0.2 145)"
        strokeWidth={5}
        strokeLinecap="round"
      />
      {/* Needle */}
      <line
        x1={cx}
        y1={cy}
        x2={nx}
        y2={ny}
        stroke="var(--color-text-main)"
        strokeWidth={1.5}
        strokeLinecap="round"
        style={{ transition: 'x2 0.2s ease, y2 0.2s ease' }}
      />
      {/* Pivot dot */}
      <circle cx={cx} cy={cy} r={2.5} fill="var(--color-text-main)" />
      {/* Value label */}
      <text
        x={cx}
        y={62}
        textAnchor="middle"
        fontSize={8}
        fill="var(--color-text-muted)"
        fontFamily="monospace"
      >
        {value.toFixed(1)} dB
      </text>
    </svg>
  );
};

// ---------------------------------------------------------------------------
// StereoHeatbar — phase correlation / stereo balance bar with triangle indicator
// ---------------------------------------------------------------------------

interface StereoHeatbarProps {
  value: number;        // -1.0 to +1.0
  isPhaseIssue?: boolean; // true when value < 0
  label: string;
}

const StereoHeatbar: React.FC<StereoHeatbarProps> = ({ value, isPhaseIssue, label }) => {
  const WIDTH = 160;
  const BAR_HEIGHT = 8;
  const INDICATOR_H = 12;
  const clampedValue = Math.max(-1, Math.min(1, value));
  const xPos = ((clampedValue + 1) / 2) * WIDTH; // 0..WIDTH

  // Choose indicator fill based on health
  const indicatorFill = isPhaseIssue
    ? 'oklch(0.55 0.22 25)'
    : clampedValue > 0.5
    ? 'oklch(0.65 0.2 145)'
    : 'oklch(0.75 0.18 85)';

  // Triangle indicator: points downward at xPos
  const triTop = 0;
  const triBottom = INDICATOR_H;
  const triHalf = 5;
  const trianglePoints = `${xPos},${triBottom} ${xPos - triHalf},${triTop} ${xPos + triHalf},${triTop}`;

  return (
    <div className="flex flex-col gap-1">
      <span className="text-[9px] uppercase tracking-widest font-bold text-text-muted">{label}</span>
      <svg
        width={WIDTH}
        height={38}
        viewBox={`0 0 ${WIDTH} 38`}
        aria-label={`${label} ${value.toFixed(2)}`}
      >
        {/* Triangle indicator — sits above bar */}
        <polygon
          points={trianglePoints}
          fill={indicatorFill}
          style={{ transition: 'points 0.15s ease' }}
        />
        {/* Background bar */}
        <rect
          x={0}
          y={INDICATOR_H + 2}
          width={WIDTH}
          height={BAR_HEIGHT}
          rx={2}
          fill={isPhaseIssue ? 'oklch(0.65 0.2 25 / 0.3)' : 'var(--color-panel-border)'}
          style={{ transition: 'fill 0.15s ease' }}
        />
        {/* Mono center dashed line */}
        <line
          x1={WIDTH / 2}
          y1={INDICATOR_H + 2}
          x2={WIDTH / 2}
          y2={INDICATOR_H + 2 + BAR_HEIGHT}
          stroke="var(--color-text-muted)"
          strokeWidth={1}
          strokeDasharray="2 2"
        />
        {/* Scale labels */}
        <text x={1} y={36} fontSize={7} fill="var(--color-text-muted)" fontFamily="monospace">-1</text>
        <text x={WIDTH / 2} y={36} fontSize={7} fill="var(--color-text-muted)" fontFamily="monospace" textAnchor="middle">0</text>
        <text x={WIDTH - 1} y={36} fontSize={7} fill="var(--color-text-muted)" fontFamily="monospace" textAnchor="end">+1</text>
      </svg>
    </div>
  );
};

// ---------------------------------------------------------------------------
// CentroidNeedle — log-scale spectral centroid indicator bar
// ---------------------------------------------------------------------------

interface CentroidNeedleProps {
  value: number;  // Hz, 20–20000
}

const CentroidNeedle: React.FC<CentroidNeedleProps> = ({ value }) => {
  const WIDTH = 160;
  const BAR_HEIGHT = 8;
  const INDICATOR_H = 12;

  const LOG_MIN = Math.log10(20);
  const LOG_MAX = Math.log10(20000);
  const clampedValue = Math.max(20, Math.min(20000, value));
  const pos = (Math.log10(clampedValue) - LOG_MIN) / (LOG_MAX - LOG_MIN); // 0..1
  const xPos = pos * WIDTH;

  // Tick positions (log-scale)
  const ticks: { hz: number; label: string }[] = [
    { hz: 100,   label: '100' },
    { hz: 1000,  label: '1k' },
    { hz: 10000, label: '10k' },
  ];

  const tickX = (hz: number) =>
    ((Math.log10(hz) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * WIDTH;

  // Triangle indicator pointing downward
  const triHalf = 5;
  const triTop = 0;
  const triBottom = INDICATOR_H;
  const trianglePoints = `${xPos},${triBottom} ${xPos - triHalf},${triTop} ${xPos + triHalf},${triTop}`;

  return (
    <svg
      width={WIDTH}
      height={38}
      viewBox={`0 0 ${WIDTH} 38`}
      aria-label={`Centroid ${value.toFixed(0)} Hz`}
    >
      {/* Triangle indicator */}
      <polygon
        points={trianglePoints}
        fill="var(--color-accent)"
        style={{ transition: 'points 0.15s ease' }}
      />
      {/* Background bar */}
      <rect
        x={0}
        y={INDICATOR_H + 2}
        width={WIDTH}
        height={BAR_HEIGHT}
        rx={2}
        fill="var(--color-panel-border)"
      />
      {/* Tick marks */}
      {ticks.map(({ hz, label }) => {
        const tx = tickX(hz);
        return (
          <g key={hz}>
            <line
              x1={tx}
              y1={INDICATOR_H + 2}
              x2={tx}
              y2={INDICATOR_H + 2 + BAR_HEIGHT}
              stroke="var(--color-text-muted)"
              strokeWidth={0.75}
              opacity={0.5}
            />
            <text
              x={tx}
              y={36}
              fontSize={7}
              fill="var(--color-text-muted)"
              fontFamily="monospace"
              textAnchor="middle"
            >
              {label}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

const MaskingIndicator: React.FC<{ masked: boolean }> = ({ masked }) => (
  <div className="flex items-center gap-2">
    <div
      className="w-2 h-2 rounded-full transition-colors duration-150"
      style={{
        backgroundColor: masked ? 'oklch(0.65 0.2 25)' : 'var(--color-panel-border)',
        boxShadow: masked ? '0 0 6px oklch(0.65 0.2 25)' : 'none',
      }}
    />
    <span
      className="text-[9px] uppercase tracking-widest font-bold transition-colors duration-150"
      style={{ color: masked ? 'oklch(0.65 0.2 25)' : 'var(--color-text-muted)' }}
    >
      {masked ? 'Masking' : 'Clear'}
    </span>
  </div>
);
