import React, { useState, useRef, useEffect, useImperativeHandle } from 'react';
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
  latestFrameRef: React.MutableRefObject<DspFramePayload | null>;
  isStreaming: boolean;
  lra?: number;
}

// Canonical stem OKLCH colors
const STEM_COLORS = {
  dx:      'oklch(0.72 0.14 155)',
  music:   'oklch(0.70 0.10 290)',
  effects: 'oklch(0.75 0.16 65)',
} as const;

export interface StemLufsRowHandle {
  update: (momentaryLufs: number, truePeakDbtp: number) => void;
}

interface StemLufsRowProps {
  label: string;
  color: string;
  ref?: React.Ref<StemLufsRowHandle>;
}

const LUFS_MIN = -48;
const LUFS_MAX = 0;
const BAR_H = 6;
const CANVAS_H = 32;
const BAR_Y = (CANVAS_H - BAR_H) / 2;

/** Paints the LUFS bar + peak-hold tick onto an already-scaled canvas context. */
function paintStemBar(
  ctx: CanvasRenderingContext2D,
  width: number,
  lufsPct: number,
  peakPct: number,
  color: string,
): void {
  ctx.clearRect(0, 0, width, CANVAS_H);

  const borderColor =
    getComputedStyle(ctx.canvas).getPropertyValue('--color-panel-border').trim() ||
    'oklch(0.25 0.02 250)';
  ctx.fillStyle = borderColor;
  fillRoundRect(ctx, 0, BAR_Y, width, BAR_H, 2);

  if (lufsPct > 0) {
    ctx.save();
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = color;
    fillRoundRect(ctx, 0, BAR_Y, lufsPct * width, BAR_H, 2);
    ctx.restore();
  }

  if (peakPct > 0) {
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(peakPct * width), BAR_Y, 1, BAR_H);
    ctx.restore();
  }
}

const StemLufsRow: React.FC<StemLufsRowProps> = ({ label, color, ref }) => {
  const TP_CEILING = -1;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lufsTextRef = useRef<HTMLSpanElement>(null);
  const tpTextRef = useRef<HTMLSpanElement>(null);
  const peakLufsRef = useRef<number>(-Infinity);
  const valuesRef = useRef<{ momentaryLufs: number; truePeakDbtp: number }>({
    momentaryLufs: -Infinity,
    truePeakDbtp: -Infinity,
  });

  useImperativeHandle(ref, () => ({
    update: (momentaryLufs: number, truePeakDbtp: number) => {
      valuesRef.current = { momentaryLufs, truePeakDbtp };

      if (momentaryLufs > peakLufsRef.current) {
        peakLufsRef.current = momentaryLufs;
      }

      if (lufsTextRef.current) {
        lufsTextRef.current.textContent = momentaryLufs <= -48 ? '--' : momentaryLufs.toFixed(1);
        lufsTextRef.current.className = `font-mono text-base font-semibold tabular-nums leading-none w-14 shrink-0 ${momentaryLufs <= -48 ? 'text-text-muted' : 'text-text-main'}`;
      }
      if (tpTextRef.current) {
        const tpDanger = truePeakDbtp > TP_CEILING;
        tpTextRef.current.textContent = `TP ${truePeakDbtp > -120 ? truePeakDbtp.toFixed(1) : '--'}`;
        tpTextRef.current.className = `text-[9px] font-mono tabular-nums ${tpDanger ? 'text-danger' : 'text-text-muted'}`;
      }

      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;

      const width = container.getBoundingClientRect().width;
      if (width === 0) return;
      const dpr = window.devicePixelRatio || 1;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Re-allocate backing store only when size/dpr actually changes.
      const targetW = Math.floor(width * dpr);
      const targetH = Math.floor(CANVAS_H * dpr);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${CANVAS_H}px`;
        ctx.scale(dpr, dpr);
      }

      const lufsPct = Math.max(0, Math.min(1, (momentaryLufs - LUFS_MIN) / (LUFS_MAX - LUFS_MIN)));
      const peakPct = Math.max(0, Math.min(1, (peakLufsRef.current - LUFS_MIN) / (LUFS_MAX - LUFS_MIN)));
      paintStemBar(ctx, width, lufsPct, peakPct, color);
    },
  }), [color]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => {
      const { momentaryLufs, truePeakDbtp: _tp } = valuesRef.current;
      if (momentaryLufs > -Infinity) {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const width = container.getBoundingClientRect().width;
        if (width === 0) return;
        const dpr = window.devicePixelRatio || 1;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Re-allocate backing store only when size/dpr actually changes.
        const targetW = Math.floor(width * dpr);
        const targetH = Math.floor(CANVAS_H * dpr);
        if (canvas.width !== targetW || canvas.height !== targetH) {
          canvas.width = targetW;
          canvas.height = targetH;
          canvas.style.width = `${width}px`;
          canvas.style.height = `${CANVAS_H}px`;
          ctx.scale(dpr, dpr);
        }

        const lufsPct = Math.max(0, Math.min(1, (momentaryLufs - LUFS_MIN) / (LUFS_MAX - LUFS_MIN)));
        const peakPct = Math.max(0, Math.min(1, (peakLufsRef.current - LUFS_MIN) / (LUFS_MAX - LUFS_MIN)));
        paintStemBar(ctx, width, lufsPct, peakPct, color);
      }
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [color]);

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex justify-between items-baseline">
        <span className="text-[9px] uppercase tracking-widest font-bold" style={{ color }}>
          {label}
        </span>
        <span ref={tpTextRef} className="text-[9px] font-mono tabular-nums text-text-muted">
          TP --
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="flex items-baseline gap-0.5">
          <span ref={lufsTextRef} className="font-mono text-base font-semibold tabular-nums leading-none w-14 shrink-0 text-text-muted">--</span>
          <span className="text-[9px] font-normal text-text-muted">M</span>
        </span>
        <div ref={containerRef} className="flex-1">
          <canvas ref={canvasRef} className="block" />
        </div>
      </div>
    </div>
  );
};

export const LiveMeters: React.FC<LiveMetersProps> = ({ latestFrameRef, isStreaming, lra }) => {
  const stemDxRef    = useRef<StemLufsRowHandle>(null);
  const stemMusicRef = useRef<StemLufsRowHandle>(null);
  const stemFxRef    = useRef<StemLufsRowHandle>(null);
  const gaugeRef     = useRef<SemiCircleGaugeHandle>(null);
  const phaseBarRef  = useRef<StereoHeatbarHandle>(null);
  const centroidRef  = useRef<CentroidNeedleHandle>(null);
  const maskingRef   = useRef<MaskingIndicatorHandle>(null);
  const centroidTextRef = useRef<HTMLSpanElement>(null);
  const rafRef       = useRef<number | null>(null);

  useEffect(() => {
    if (!isStreaming) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    const loop = () => {
      const frame = latestFrameRef.current;
      if (frame) {
        stemDxRef.current?.update(frame.dialogue_momentary_lufs, frame.dialogue_true_peak_dbtp);
        stemMusicRef.current?.update(frame.music_momentary_lufs, frame.music_true_peak_dbtp);
        stemFxRef.current?.update(frame.effects_momentary_lufs, frame.effects_true_peak_dbtp);
        gaugeRef.current?.update(frame.snr_db);
        phaseBarRef.current?.update(frame.phase_correlation, frame.phase_correlation < 0);
        centroidRef.current?.update(frame.dialogue_centroid_hz);
        maskingRef.current?.update(frame.speech_pocket_masked);
        if (centroidTextRef.current) {
          centroidTextRef.current.textContent = frame.dialogue_centroid_hz.toFixed(0);
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isStreaming, latestFrameRef]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-1">
        <span className="text-[9px] uppercase tracking-widest font-bold text-text-muted">SNR</span>
        <SemiCircleGauge ref={gaugeRef} />
      </div>
      <StereoHeatbar ref={phaseBarRef} label="Phase" />
      <div className="flex flex-col gap-2">
        <span className="text-[9px] uppercase tracking-widest font-bold text-text-muted">Loudness — Momentary</span>
        <StemLufsRow ref={stemDxRef}    label="DX"      color={STEM_COLORS.dx} />
        <StemLufsRow ref={stemMusicRef} label="Music"   color={STEM_COLORS.music} />
        <StemLufsRow ref={stemFxRef}    label="Effects" color={STEM_COLORS.effects} />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[9px] uppercase tracking-widest font-bold text-text-muted">Centroid</span>
        <span className="font-mono text-xl font-semibold text-text-main tabular-nums leading-none">
          <span ref={centroidTextRef}>--</span>
          <span className="text-xs font-normal text-text-muted ml-1">Hz</span>
        </span>
        <CentroidNeedle ref={centroidRef} />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[9px] uppercase tracking-widest font-bold text-text-muted">LRA</span>
        <span className="font-mono text-xl font-semibold text-text-main tabular-nums leading-none">
          {lra !== undefined ? `${lra.toFixed(1)}` : '--'}
          {lra !== undefined && <span className="text-xs font-normal text-text-muted ml-1">LU</span>}
        </span>
      </div>
      <MaskingIndicator ref={maskingRef} />
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

export interface SemiCircleGaugeHandle {
  update: (value: number) => void;
}

interface SemiCircleGaugeProps {
  min?: number;
  max?: number;
  ref?: React.Ref<SemiCircleGaugeHandle>;
}

const SemiCircleGauge: React.FC<SemiCircleGaugeProps> = ({ min = 0, max = 40, ref }) => {
  const needleRef = useRef<SVGLineElement>(null);
  const textRef = useRef<SVGTextElement>(null);
  const cx = 60; const cy = 60; const r = 50; const needleLength = 44;

  useImperativeHandle(ref, () => ({
    update: (value: number) => {
      const clamped = Math.max(min, Math.min(max, value));
      const frac = (clamped - min) / (max - min);
      const deg = 180 - frac * 180;
      const rad = (deg * Math.PI) / 180;
      const nx = cx + needleLength * Math.cos(rad);
      const ny = cy - needleLength * Math.sin(rad);
      if (needleRef.current) {
        needleRef.current.setAttribute('x2', nx.toFixed(2));
        needleRef.current.setAttribute('y2', ny.toFixed(2));
      }
      if (textRef.current) {
        textRef.current.textContent = `${value.toFixed(1)} dB`;
      }
    },
  }), [min, max]);

  function arcPath(fracStart: number, fracEnd: number): string {
    const degStart = 180 - fracStart * 180;
    const degEnd   = 180 - fracEnd   * 180;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const x1 = cx + r * Math.cos(toRad(degStart));
    const y1 = cy - r * Math.sin(toRad(degStart));
    const x2 = cx + r * Math.cos(toRad(degEnd));
    const y2 = cy - r * Math.sin(toRad(degEnd));
    return `M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`;
  }

  const redEnd    = (5  - min) / (max - min);
  const yellowEnd = (15 - min) / (max - min);

  return (
    <svg width={120} height={65} viewBox="0 0 120 65" aria-label="SNR gauge">
      <path d={arcPath(0, redEnd)}       fill="none" stroke="oklch(0.55 0.22 25)" strokeWidth={5} strokeLinecap="round" />
      <path d={arcPath(redEnd, yellowEnd)} fill="none" stroke="oklch(0.75 0.18 85)" strokeWidth={5} strokeLinecap="round" />
      <path d={arcPath(yellowEnd, 1)}    fill="none" stroke="oklch(0.65 0.2 145)"  strokeWidth={5} strokeLinecap="round" />
      <line ref={needleRef} x1={cx} y1={cy} x2={cx} y2={cy} stroke="var(--color-text-main)" strokeWidth={1.5} strokeLinecap="round" />
      <circle cx={cx} cy={cy} r={2.5} fill="var(--color-text-main)" />
      <text ref={textRef} x={cx} y={62} textAnchor="middle" fontSize={8} fill="var(--color-text-muted)" fontFamily="monospace">
        -- dB
      </text>
    </svg>
  );
};

// ---------------------------------------------------------------------------
// StereoHeatbar — phase correlation / stereo balance bar with triangle indicator
// ---------------------------------------------------------------------------

export interface StereoHeatbarHandle {
  update: (value: number, isPhaseIssue: boolean) => void;
}

interface StereoHeatbarProps {
  label: string;
  ref?: React.Ref<StereoHeatbarHandle>;
}

const StereoHeatbar: React.FC<StereoHeatbarProps> = ({ label, ref }) => {
  const polygonRef = useRef<SVGPolygonElement>(null);
  const WIDTH = 160; const INDICATOR_H = 12; const triHalf = 5;

  useImperativeHandle(ref, () => ({
    update: (value: number, isPhaseIssue: boolean) => {
      const clamped = Math.max(-1, Math.min(1, value));
      const xPos = ((clamped + 1) / 2) * WIDTH;
      const points = `${xPos},${INDICATOR_H} ${xPos - triHalf},0 ${xPos + triHalf},0`;
      const fill = isPhaseIssue
        ? 'oklch(0.55 0.22 25)'
        : clamped > 0.5 ? 'oklch(0.65 0.2 145)' : 'oklch(0.75 0.18 85)';
      if (polygonRef.current) {
        polygonRef.current.setAttribute('points', points);
        polygonRef.current.setAttribute('fill', fill);
      }
    },
  }), []);

  return (
    <div className="flex flex-col gap-1">
      <span className="text-[9px] uppercase tracking-widest font-bold text-text-muted">{label}</span>
      <svg width={160} height={38} viewBox="0 0 160 38" aria-label={`${label} indicator`}>
        <polygon ref={polygonRef} points="80,12 75,0 85,0" fill="oklch(0.75 0.18 85)" />
        <rect x={0} y={14} width={160} height={8} rx={2} fill="var(--color-panel-border)" />
        <line x1={80} y1={14} x2={80} y2={22} stroke="var(--color-text-muted)" strokeWidth={1} strokeDasharray="2 2" />
        <text x={1}   y={36} fontSize={7} fill="var(--color-text-muted)" fontFamily="monospace">-1</text>
        <text x={80}  y={36} fontSize={7} fill="var(--color-text-muted)" fontFamily="monospace" textAnchor="middle">0</text>
        <text x={159} y={36} fontSize={7} fill="var(--color-text-muted)" fontFamily="monospace" textAnchor="end">+1</text>
      </svg>
    </div>
  );
};

// ---------------------------------------------------------------------------
// CentroidNeedle — log-scale spectral centroid indicator bar
// ---------------------------------------------------------------------------

export interface CentroidNeedleHandle {
  update: (value: number) => void;
}

interface CentroidNeedleProps {
  ref?: React.Ref<CentroidNeedleHandle>;
}

const CentroidNeedle: React.FC<CentroidNeedleProps> = ({ ref }) => {
  const polygonRef = useRef<SVGPolygonElement>(null);
  const WIDTH = 160; const INDICATOR_H = 12; const triHalf = 5;
  const LOG_MIN = Math.log10(20); const LOG_MAX = Math.log10(20000);

  useImperativeHandle(ref, () => ({
    update: (value: number) => {
      const clamped = Math.max(20, Math.min(20000, value));
      const pos = (Math.log10(clamped) - LOG_MIN) / (LOG_MAX - LOG_MIN);
      const xPos = pos * WIDTH;
      const points = `${xPos},${INDICATOR_H} ${xPos - triHalf},0 ${xPos + triHalf},0`;
      if (polygonRef.current) {
        polygonRef.current.setAttribute('points', points);
      }
    },
  }), []);

  const tickX = (hz: number) => ((Math.log10(hz) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * WIDTH;
  const ticks = [{ hz: 100, label: '100' }, { hz: 1000, label: '1k' }, { hz: 10000, label: '10k' }];

  return (
    <svg width={160} height={38} viewBox="0 0 160 38" aria-label="Spectral centroid indicator">
      <polygon ref={polygonRef} points="80,12 75,0 85,0" fill="var(--color-accent)" />
      <rect x={0} y={14} width={160} height={8} rx={2} fill="var(--color-panel-border)" />
      {ticks.map(({ hz, label }) => {
        const tx = tickX(hz);
        return (
          <g key={hz}>
            <line x1={tx} y1={14} x2={tx} y2={22} stroke="var(--color-text-muted)" strokeWidth={0.75} opacity={0.5} />
            <text x={tx} y={36} fontSize={7} fill="var(--color-text-muted)" fontFamily="monospace" textAnchor="middle">{label}</text>
          </g>
        );
      })}
    </svg>
  );
};

export interface MaskingIndicatorHandle {
  update: (masked: boolean) => void;
}

interface MaskingIndicatorProps {
  ref?: React.Ref<MaskingIndicatorHandle>;
}

const MaskingIndicator: React.FC<MaskingIndicatorProps> = ({ ref }) => {
  const dotRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);

  useImperativeHandle(ref, () => ({
    update: (masked: boolean) => {
      if (dotRef.current) {
        dotRef.current.className = `w-2 h-2 rounded-full ${masked ? 'bg-danger' : 'bg-panel-border'}`;
        dotRef.current.style.boxShadow = masked ? '0 0 6px var(--color-danger)' : 'none';
      }
      if (labelRef.current) {
        labelRef.current.className = `text-[9px] uppercase tracking-widest font-bold ${masked ? 'text-danger' : 'text-text-muted'}`;
        labelRef.current.textContent = masked ? 'Masking' : 'Clear';
      }
    },
  }), []);

  return (
    <div className="flex items-center gap-2">
      <div ref={dotRef} className="w-2 h-2 rounded-full bg-panel-border" />
      <span ref={labelRef} className="text-[9px] uppercase tracking-widest font-bold text-text-muted">
        Clear
      </span>
    </div>
  );
};
