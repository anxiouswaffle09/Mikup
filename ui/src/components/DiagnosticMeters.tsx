import React, { useState, useRef, useEffect } from 'react';
import type { DiagnosticMetrics } from '../types';
import type { DspFramePayload } from '../types';

interface StatsBarProps {
  metrics: DiagnosticMetrics;
  eventCount: number;
  integratedLufs: number | null;
}

export const StatsBar: React.FC<StatsBarProps> = ({ metrics, eventCount, integratedLufs }) => {
  return (
    <div className="@container border-t border-b border-panel-border py-4">
      <div className="grid grid-cols-2 @md:grid-cols-5 gap-x-6 gap-y-4">
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

/** Draws a filled rectangle with rounded corners without relying on roundRect() (not in TS ES2022 DOM lib). */
function fillRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  if (w <= 0) return;
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
  ctx.fill();
}

const StatCell: React.FC<StatCellProps> = ({
  label,
  value,
  unit,
  min,
  max,
  interpret,
  hideBar,
  decimals,
  targets,
  targetLabel,
}) => {
  const pct = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const safeTargets = (targets ?? []).map((target) =>
    Math.max(0, Math.min(1, (target - min) / (max - min))),
  );
  const precision =
    typeof decimals === 'number' ? decimals : value % 1 === 0 ? 0 : 2;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Stable primitive dep for target positions — avoids re-firing on every render.
  const targetsKey = safeTargets.join(',');

  useEffect(() => {
    if (hideBar) return;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    let rafId: number;

    const paint = (width: number) => {
      const dpr = window.devicePixelRatio || 1;
      const h = 4;

      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${h}px`;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.scale(dpr, dpr);

      const borderColor =
        getComputedStyle(canvas).getPropertyValue('--color-panel-border').trim() ||
        'oklch(0.25 0.02 250)';
      const accentColor =
        getComputedStyle(canvas).getPropertyValue('--color-accent').trim() ||
        'oklch(0.6 0.2 250)';

      // Background track
      ctx.fillStyle = borderColor;
      ctx.fillRect(0, 0, width, h);

      // Fill bar up to current value
      if (pct > 0) {
        ctx.fillStyle = accentColor;
        ctx.fillRect(0, 0, pct * width, h);
      }

      // Target tick marks — 1px wide, full height, warm amber
      ctx.fillStyle = 'oklch(0.65 0.14 20)';
      for (const targetPos of safeTargets) {
        const x = Math.round(targetPos * width);
        ctx.fillRect(x, 0, 1, h);
      }
    };

    const schedule = (width: number) => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => paint(width));
    };

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        schedule(entry.contentRect.width);
      }
    });
    ro.observe(container);
    schedule(container.getBoundingClientRect().width);

    return () => {
      ro.disconnect();
      cancelAnimationFrame(rafId);
    };
  // targetsKey is a serialised stable primitive derived from safeTargets
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hideBar, pct, targetsKey]);

  return (
    <div className="flex flex-col gap-1">
      <span className="text-[9px] uppercase tracking-widest font-bold text-text-muted">
        {label}
      </span>
      <span className="font-mono text-xl font-semibold text-text-main tabular-nums leading-none">
        {typeof value === 'number' ? value.toFixed(precision) : '--'}
        {unit && (
          <span className="text-xs font-normal text-text-muted ml-1">{unit}</span>
        )}
      </span>
      {!hideBar && (
        <div ref={containerRef} className="w-full mt-1">
          <canvas ref={canvasRef} className="block w-full h-1" />
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

// Canonical stem OKLCH colors
const STEM_COLORS = {
  dx:      'oklch(0.72 0.14 155)',
  music:   'oklch(0.70 0.10 290)',
  effects: 'oklch(0.75 0.16 65)',
} as const;

interface StemLufsRowProps {
  label: string;
  color: string;
  momentaryLufs: number;
  truePeakDbtp: number;
}

const LUFS_MIN = -48;
const LUFS_MAX = 0;
const BAR_H = 6;
const CANVAS_H = 32;
const BAR_Y = (CANVAS_H - BAR_H) / 2;

const StemLufsRow: React.FC<StemLufsRowProps> = ({
  label,
  color,
  momentaryLufs,
  truePeakDbtp,
}) => {
  const TP_CEILING = -1;

  const lufsPct = Math.max(0, Math.min(1, (momentaryLufs - LUFS_MIN) / (LUFS_MAX - LUFS_MIN)));
  const tpDanger = truePeakDbtp > TP_CEILING;

  // Peak hold: React-approved "adjust state when prop changes" pattern.
  const [peakLufs, setPeakLufs] = useState(momentaryLufs);
  if (momentaryLufs > peakLufs) setPeakLufs(momentaryLufs);
  const peakPct = Math.max(0, Math.min(1, (peakLufs - LUFS_MIN) / (LUFS_MAX - LUFS_MIN)));

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    let rafId: number;

    const paint = (width: number) => {
      const dpr = window.devicePixelRatio || 1;

      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(CANVAS_H * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${CANVAS_H}px`;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, CANVAS_H);

      // Background track (full width, rounded, vertically centered)
      const borderColor =
        getComputedStyle(canvas).getPropertyValue('--color-panel-border').trim() ||
        'oklch(0.25 0.02 250)';
      ctx.fillStyle = borderColor;
      fillRoundRect(ctx, 0, BAR_Y, width, BAR_H, 2);

      // Live fill bar (stem color at 0.8 opacity)
      if (lufsPct > 0) {
        ctx.save();
        ctx.globalAlpha = 0.8;
        ctx.fillStyle = color;
        fillRoundRect(ctx, 0, BAR_Y, lufsPct * width, BAR_H, 2);
        ctx.restore();
      }

      // Peak-hold tick (1px wide, stem color at 0.5 opacity)
      if (peakPct > 0) {
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = color;
        ctx.fillRect(Math.round(peakPct * width), BAR_Y, 1, BAR_H);
        ctx.restore();
      }
    };

    const schedule = (width: number) => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => paint(width));
    };

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        schedule(entry.contentRect.width);
      }
    });
    ro.observe(container);
    schedule(container.getBoundingClientRect().width);

    return () => {
      ro.disconnect();
      cancelAnimationFrame(rafId);
    };
  }, [color, lufsPct, peakPct]);

  return (
    <div className="flex flex-col gap-0.5">
      {/* Top row: stem label + TP value */}
      <div className="flex justify-between items-baseline">
        <span
          className="text-[9px] uppercase tracking-widest font-bold"
          style={{ color }}
        >
          {label}
        </span>
        <span
          className={`text-[9px] font-mono tabular-nums ${tpDanger ? 'text-danger' : 'text-text-muted'}`}
        >
          TP {truePeakDbtp > -120 ? truePeakDbtp.toFixed(1) : '--'}
        </span>
      </div>
      {/* Bottom row: numeric readout + canvas meter bar */}
      <div className="flex items-center gap-2">
        <span
          className={`font-mono text-base font-semibold tabular-nums leading-none w-14 shrink-0 ${momentaryLufs <= -48 ? 'text-text-muted' : 'text-text-main'}`}
        >
          {momentaryLufs <= -48 ? '--' : momentaryLufs.toFixed(1)}
          <span className="text-[9px] font-normal text-text-muted ml-0.5">M</span>
        </span>
        <div ref={containerRef} className="flex-1">
          <canvas ref={canvasRef} className="block" />
        </div>
      </div>
    </div>
  );
};

export const LiveMeters: React.FC<LiveMetersProps> = React.memo(({ frame, lra }) => {
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-1">
        <span className="text-[9px] uppercase tracking-widest font-bold text-text-muted">SNR</span>
        <SemiCircleGauge value={frame.snr_db} min={0} max={40} />
      </div>
      <StereoHeatbar value={frame.phase_correlation} isPhaseIssue={frame.phase_correlation < 0} label="Phase" />
      {/* 3-Stem Loudness */}
      <div className="flex flex-col gap-2">
        <span className="text-[9px] uppercase tracking-widest font-bold text-text-muted">Loudness — Momentary</span>
        <StemLufsRow
          label="DX"
          color={STEM_COLORS.dx}
          momentaryLufs={frame.dialogue_momentary_lufs}
          truePeakDbtp={frame.dialogue_true_peak_dbtp}
        />
        <StemLufsRow
          label="Music"
          color={STEM_COLORS.music}
          momentaryLufs={frame.music_momentary_lufs}
          truePeakDbtp={frame.music_true_peak_dbtp}
        />
        <StemLufsRow
          label="Effects"
          color={STEM_COLORS.effects}
          momentaryLufs={frame.effects_momentary_lufs}
          truePeakDbtp={frame.effects_true_peak_dbtp}
        />
      </div>
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
}) as React.FC<LiveMetersProps>;

interface LiveStatCellProps {
  label: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  decimals?: number;
  targets?: number[];
  targetLabel?: string;
  dangerAbove?: number;
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
        className={`font-mono text-xl font-semibold tabular-nums leading-none transition-colors duration-150 ${inDanger ? 'text-danger' : 'text-text-main'}`}
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
        <div
          className="absolute top-[-1px] h-[3px] w-[1px] bg-text-muted/40 transition-all duration-300"
          style={{ left: `${peakPct * 100}%` }}
        />
        <div
          className={`absolute top-0 left-0 h-px transition-all duration-150 ${inDanger ? 'bg-danger' : 'bg-accent'}`}
          style={{ width: `${pct * 100}%` }}
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
  value: number;
  min?: number;
  max?: number;
}

const SemiCircleGauge: React.FC<SemiCircleGaugeProps> = ({ value, min = 0, max = 40 }) => {
  const cx = 60;
  const cy = 60;
  const r = 50;

  function arcPath(fracStart: number, fracEnd: number): string {
    const degStart = 180 - fracStart * 180;
    const degEnd = 180 - fracEnd * 180;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const x1 = cx + r * Math.cos(toRad(degStart));
    const y1 = cy - r * Math.sin(toRad(degStart));
    const x2 = cx + r * Math.cos(toRad(degEnd));
    const y2 = cy - r * Math.sin(toRad(degEnd));
    return `M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`;
  }

  const redStart   = 0;
  const redEnd     = (5  - min) / (max - min);
  const yellowEnd  = (15 - min) / (max - min);
  const greenEnd   = 1;

  const clampedValue = Math.max(min, Math.min(max, value));
  const needleFrac = (clampedValue - min) / (max - min);
  const needleDeg = 180 - needleFrac * 180;
  const needleRad = (needleDeg * Math.PI) / 180;
  const needleLength = 44;
  const nx = cx + needleLength * Math.cos(needleRad);
  const ny = cy - needleLength * Math.sin(needleRad);

  return (
    <svg width={120} height={65} viewBox="0 0 120 65" aria-label={`SNR ${value.toFixed(1)} dB`}>
      <path d={arcPath(redStart, redEnd)} fill="none" stroke="oklch(0.55 0.22 25)" strokeWidth={5} strokeLinecap="round" />
      <path d={arcPath(redEnd, yellowEnd)} fill="none" stroke="oklch(0.75 0.18 85)" strokeWidth={5} strokeLinecap="round" />
      <path d={arcPath(yellowEnd, greenEnd)} fill="none" stroke="oklch(0.65 0.2 145)" strokeWidth={5} strokeLinecap="round" />
      <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="var(--color-text-main)" strokeWidth={1.5} strokeLinecap="round" style={{ transition: 'x2 0.2s ease, y2 0.2s ease' }} />
      <circle cx={cx} cy={cy} r={2.5} fill="var(--color-text-main)" />
      <text x={cx} y={62} textAnchor="middle" fontSize={8} fill="var(--color-text-muted)" fontFamily="monospace">
        {value.toFixed(1)} dB
      </text>
    </svg>
  );
};

// ---------------------------------------------------------------------------
// StereoHeatbar — phase correlation / stereo balance bar with triangle indicator
// ---------------------------------------------------------------------------

interface StereoHeatbarProps {
  value: number;
  isPhaseIssue?: boolean;
  label: string;
}

const StereoHeatbar: React.FC<StereoHeatbarProps> = ({ value, isPhaseIssue, label }) => {
  const WIDTH = 160;
  const BAR_HEIGHT = 8;
  const INDICATOR_H = 12;
  const clampedValue = Math.max(-1, Math.min(1, value));
  const xPos = ((clampedValue + 1) / 2) * WIDTH;

  const indicatorFill = isPhaseIssue
    ? 'oklch(0.55 0.22 25)'
    : clampedValue > 0.5
    ? 'oklch(0.65 0.2 145)'
    : 'oklch(0.75 0.18 85)';

  const triTop = 0;
  const triBottom = INDICATOR_H;
  const triHalf = 5;
  const trianglePoints = `${xPos},${triBottom} ${xPos - triHalf},${triTop} ${xPos + triHalf},${triTop}`;

  return (
    <div className="flex flex-col gap-1">
      <span className="text-[9px] uppercase tracking-widest font-bold text-text-muted">{label}</span>
      <svg width={WIDTH} height={38} viewBox={`0 0 ${WIDTH} 38`} aria-label={`${label} ${value.toFixed(2)}`}>
        <polygon points={trianglePoints} fill={indicatorFill} style={{ transition: 'points 0.15s ease' }} />
        <rect x={0} y={INDICATOR_H + 2} width={WIDTH} height={BAR_HEIGHT} rx={2} fill={isPhaseIssue ? 'oklch(0.65 0.2 25 / 0.3)' : 'var(--color-panel-border)'} style={{ transition: 'fill 0.15s ease' }} />
        <line x1={WIDTH / 2} y1={INDICATOR_H + 2} x2={WIDTH / 2} y2={INDICATOR_H + 2 + BAR_HEIGHT} stroke="var(--color-text-muted)" strokeWidth={1} strokeDasharray="2 2" />
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
  value: number;
}

const CentroidNeedle: React.FC<CentroidNeedleProps> = ({ value }) => {
  const WIDTH = 160;
  const BAR_HEIGHT = 8;
  const INDICATOR_H = 12;

  const LOG_MIN = Math.log10(20);
  const LOG_MAX = Math.log10(20000);
  const clampedValue = Math.max(20, Math.min(20000, value));
  const pos = (Math.log10(clampedValue) - LOG_MIN) / (LOG_MAX - LOG_MIN);
  const xPos = pos * WIDTH;

  const ticks: { hz: number; label: string }[] = [
    { hz: 100,   label: '100' },
    { hz: 1000,  label: '1k' },
    { hz: 10000, label: '10k' },
  ];

  const tickX = (hz: number) =>
    ((Math.log10(hz) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * WIDTH;

  const triHalf = 5;
  const triTop = 0;
  const triBottom = INDICATOR_H;
  const trianglePoints = `${xPos},${triBottom} ${xPos - triHalf},${triTop} ${xPos + triHalf},${triTop}`;

  return (
    <svg width={WIDTH} height={38} viewBox={`0 0 ${WIDTH} 38`} aria-label={`Centroid ${value.toFixed(0)} Hz`}>
      <polygon points={trianglePoints} fill="var(--color-accent)" style={{ transition: 'points 0.15s ease' }} />
      <rect x={0} y={INDICATOR_H + 2} width={WIDTH} height={BAR_HEIGHT} rx={2} fill="var(--color-panel-border)" />
      {ticks.map(({ hz, label }) => {
        const tx = tickX(hz);
        return (
          <g key={hz}>
            <line x1={tx} y1={INDICATOR_H + 2} x2={tx} y2={INDICATOR_H + 2 + BAR_HEIGHT} stroke="var(--color-text-muted)" strokeWidth={0.75} opacity={0.5} />
            <text x={tx} y={36} fontSize={7} fill="var(--color-text-muted)" fontFamily="monospace" textAnchor="middle">{label}</text>
          </g>
        );
      })}
    </svg>
  );
};

const MaskingIndicator: React.FC<{ masked: boolean }> = ({ masked }) => (
  <div className="flex items-center gap-2">
    <div
      className={`w-2 h-2 rounded-full transition-colors duration-150 ${masked ? 'bg-danger' : 'bg-panel-border'}`}
      style={{ boxShadow: masked ? '0 0 6px var(--color-danger)' : 'none' }}
    />
    <span
      className={`text-[9px] uppercase tracking-widest font-bold transition-colors duration-150 ${masked ? 'text-danger' : 'text-text-muted'}`}
    >
      {masked ? 'Masking' : 'Clear'}
    </span>
  </div>
);
