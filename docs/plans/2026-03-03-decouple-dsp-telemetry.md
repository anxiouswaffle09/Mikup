# Decouple High-Frequency DSP Telemetry — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove `currentFrame` from React state so 60Hz DSP payloads write only to a MutableRefObject, eliminating reconciliation in AppContent and all downstream components during streaming.

**Architecture:** The Tauri Channel's `onmessage` writes to `latestFrameRef` (never setState). Vectorscope and LiveMeters sub-components each run persistent RAF loops that "pull" from the ref and paint directly to Canvas / mutate SVG DOM attributes via refs. App.tsx uses `dspStream.isStreaming` for conditional rendering and a throttled `currentTimeSecs` state (~15Hz) for the playhead.

**Tech Stack:** React 19 (useImperativeHandle, no forwardRef), Canvas 2D, SVG DOM mutation, requestAnimationFrame, Tauri Channel.

---

### Task 1: Refactor `useDspStream.ts`

**Files:**
- Modify: `ui/src/hooks/useDspStream.ts`

**Step 1: Read the current file to understand its shape**

Run: `cat ui/src/hooks/useDspStream.ts` (already read — skip)

**Step 2: Replace implementation**

New contract:
- Remove: `currentFrame: DspFramePayload | null` from state and return
- Add: `latestFrameRef: MutableRefObject<DspFramePayload | null>`
- Add: `currentTimeSecs: number` — throttled state updated at most 15Hz via a `setInterval`-like mechanism inside the channel callback
- Keep: `isStreaming`, `error`, `completePayload`, `startStream`, `stopStream`, `seekStream`

Throttle logic: maintain a `lastTimeStateUpdate` ref; inside `ch.onmessage`, if `Date.now() - lastTimeStateUpdate.current > 66` (≈15Hz), call `setCurrentTimeSecs(payload.timestamp_secs)` and update the timestamp.

```typescript
import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Channel } from '@tauri-apps/api/core';
import type { DspCompletePayload } from '../types';
import { commands } from '@bindings';
import type { DspFramePayload } from '@bindings';

export interface UseDspStreamReturn {
  /** Ref to the most recent frame — mutated at 60Hz, never causes re-renders. */
  latestFrameRef: React.MutableRefObject<DspFramePayload | null>;
  /** Throttled timestamp (~15Hz) — safe to use as React state for the playhead. */
  currentTimeSecs: number;
  completePayload: DspCompletePayload | null;
  isStreaming: boolean;
  error: string | null;
  startStream: (dxPath: string, musicPath: string, effectsPath: string, startTimeSecs?: number, sourcePath?: string) => void;
  stopStream: () => void;
  seekStream: (timeSecs: number) => void;
}

export function useDspStream(): UseDspStreamReturn {
  const latestFrameRef = useRef<DspFramePayload | null>(null);
  const [currentTimeSecs, setCurrentTimeSecs] = useState(0);
  const [completePayload, setCompletePayload] = useState<DspCompletePayload | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unlistenersRef = useRef<Array<() => void>>([]);
  const channelRef = useRef<Channel<DspFramePayload> | null>(null);
  const lastTimeUpdateRef = useRef<number>(0);

  useEffect(() => {
    let cleanedUp = false;

    const setup = async () => {
      const unlistenComplete = await listen<DspCompletePayload>('dsp-complete', (event) => {
        if (!cleanedUp) {
          setCompletePayload(event.payload);
          setIsStreaming(false);
        }
      });
      const unlistenError = await listen<string>('dsp-error', (event) => {
        if (!cleanedUp) {
          setError(event.payload);
          setIsStreaming(false);
        }
      });

      if (!cleanedUp) {
        unlistenersRef.current = [unlistenComplete, unlistenError];
      } else {
        unlistenComplete();
        unlistenError();
      }
    };

    setup();

    return () => {
      cleanedUp = true;
      unlistenersRef.current.forEach((fn) => fn());
      unlistenersRef.current = [];
      channelRef.current = null;
      latestFrameRef.current = null;
      commands.stopDspStream().catch(() => {});
    };
  }, []);

  function startStream(dxPath: string, musicPath: string, effectsPath: string, startTimeSecs?: number, sourcePath?: string) {
    latestFrameRef.current = null;
    setCurrentTimeSecs(startTimeSecs ?? 0);
    setCompletePayload(null);
    setError(null);
    setIsStreaming(true);

    const ch = new Channel<DspFramePayload>();
    ch.onmessage = (payload) => {
      // Always write to ref — zero state updates on the hot path.
      latestFrameRef.current = payload;
      // Throttle: update currentTimeSecs at ~15Hz only.
      const now = Date.now();
      if (now - lastTimeUpdateRef.current > 66) {
        lastTimeUpdateRef.current = now;
        setCurrentTimeSecs(payload.timestamp_secs);
      }
    };
    channelRef.current = ch;

    commands.streamAudioMetrics(ch, dxPath, musicPath, effectsPath, sourcePath ?? '', startTimeSecs ?? 0)
      .then((result) => {
        if (result.status === 'error') {
          setError(result.error);
          setIsStreaming(false);
        }
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setIsStreaming(false);
      });
  }

  function stopStream() {
    commands.stopDspStream().catch(() => {});
    setIsStreaming(false);
  }

  function seekStream(timeSecs: number) {
    commands.seekAudioStream(timeSecs).catch(() => {});
  }

  return { latestFrameRef, currentTimeSecs, completePayload, isStreaming, error, startStream, stopStream, seekStream };
}
```

**Step 3: Verify TypeScript compiles**

Run: `cd ui && npx tsc --noEmit 2>&1 | head -40`
Expected: errors only in files that still use the old `currentFrame` API (App.tsx, Vectorscope, DiagnosticMeters) — those will be fixed in subsequent tasks.

**Step 4: Commit**

```bash
git add ui/src/hooks/useDspStream.ts
git commit -m "refactor(dsp): replace currentFrame state with latestFrameRef + 15Hz currentTimeSecs"
```

---

### Task 2: Refactor `Vectorscope.tsx` — Persistent RAF Pull

**Files:**
- Modify: `ui/src/components/Vectorscope.tsx`

**Step 1: Replace implementation**

Key changes:
- Remove `lissajousPoints` prop
- Add `latestFrameRef: React.MutableRefObject<DspFramePayload | null>` prop
- Add `isStreaming?: boolean` prop (to stop the RAF loop when not streaming)
- Replace the single one-shot RAF (triggered by effect deps on `lissajousPoints`) with a **persistent loop** using `rafRef` that keeps scheduling itself
- When `isStreaming` becomes false, cancel the loop; when true, start it

```typescript
import { memo, useEffect, useRef } from 'react';
import type { DspFramePayload } from '@bindings';

interface VectorscopeProps {
  latestFrameRef: React.MutableRefObject<DspFramePayload | null>;
  /** Whether the stream is active — starts/stops the RAF loop. */
  isStreaming: boolean;
  /** Canvas size in px (renders as a square). Default: 200. */
  size?: number;
}

const NEON_GREEN = '#39ff14';
const GUIDE_COLOR = 'rgba(255, 255, 255, 0.06)';
const CROSS_COLOR = 'rgba(255, 255, 255, 0.10)';

export const Vectorscope = memo(function Vectorscope({ latestFrameRef, isStreaming, size = 200 }: VectorscopeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cx = size / 2;
    const cy = size / 2;
    const radius = cx * 0.88;

    // Draw static guide decorations once — they never change.
    const paintGuides = () => {
      ctx.fillStyle = 'rgb(10, 10, 10)';
      ctx.fillRect(0, 0, size, size);

      ctx.strokeStyle = GUIDE_COLOR;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = CROSS_COLOR;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy - radius);
      ctx.lineTo(cx, cy + radius);
      ctx.moveTo(cx - radius, cy);
      ctx.lineTo(cx + radius, cy);
      ctx.stroke();
    };

    paintGuides();

    if (!isStreaming) {
      // Stream stopped — leave the last frame displayed, stop the loop.
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    const loop = () => {
      const frame = latestFrameRef.current;
      const points = frame?.lissajous_points;

      // Persistence effect: semi-transparent overlay fades previous frame.
      ctx.fillStyle = 'rgba(10, 10, 10, 0.25)';
      ctx.fillRect(0, 0, size, size);

      // Re-draw guides on top of the fade.
      ctx.strokeStyle = GUIDE_COLOR;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = CROSS_COLOR;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy - radius);
      ctx.lineTo(cx, cy + radius);
      ctx.moveTo(cx - radius, cy);
      ctx.lineTo(cx + radius, cy);
      ctx.stroke();

      if (points && points.length > 0) {
        ctx.shadowBlur = 8;
        ctx.shadowColor = NEON_GREEN;
        ctx.fillStyle = NEON_GREEN;

        for (const [x, y] of points) {
          const px = cx + x * radius;
          const py = cy - y * radius;
          ctx.beginPath();
          ctx.arc(px, py, 1.2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.shadowBlur = 0;
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
  }, [isStreaming, latestFrameRef, size]);

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      aria-label="Vectorscope goniometer"
      className="block bg-console-bg"
    />
  );
});
```

**Step 2: Verify TypeScript**

Run: `cd ui && npx tsc --noEmit 2>&1 | grep Vectorscope`
Expected: no Vectorscope errors; App.tsx still has errors (fixed in Task 6).

**Step 3: Commit**

```bash
git add ui/src/components/Vectorscope.tsx
git commit -m "refactor(vectorscope): persistent RAF pull from latestFrameRef, zero prop-driven re-renders"
```

---

### Task 3: Refactor `DiagnosticMeters.tsx` — StemLufsRow to Imperative Handle

**Files:**
- Modify: `ui/src/components/DiagnosticMeters.tsx`

**Context:** `StemLufsRow` already uses canvas + RAF. The problem is its `useEffect` deps include `lufsPct` and `peakPct` which are derived from props — so it re-runs the effect (and re-paints) only when the **prop values** change, not at 60Hz. But more critically, `StemLufsRow` is re-rendered at 60Hz because `LiveMeters` receives `frame` as a prop.

The fix: give `StemLufsRow` an imperative `update(momentaryLufs, truePeakDbtp)` handle so `LiveMeters`'s RAF loop can call it directly without any prop changes or re-renders.

**Step 1: Define the handle interface and refactor StemLufsRow**

Replace the `StemLufsRowProps` and `StemLufsRow` component. Key changes:
- Remove `momentaryLufs` and `truePeakDbtp` props (these come in via the imperative handle)
- Add `ref?: React.Ref<StemLufsRowHandle>` prop (React 19 — no forwardRef needed)
- Add `useImperativeHandle` that exposes `update(momentaryLufs, truePeakDbtp)`
- The canvas paint runs inside the RAF loop triggered by `update()`, NOT by useEffect prop-deps
- `peakLufs` tracking stays internal, managed via a `useRef` (not useState — no re-render)
- Numeric text (the LUFS readout) is updated via a DOM ref (`spanRef.current.textContent = ...`)

New interface and component:

```typescript
export interface StemLufsRowHandle {
  update: (momentaryLufs: number, truePeakDbtp: number) => void;
}

interface StemLufsRowProps {
  label: string;
  color: string;
  ref?: React.Ref<StemLufsRowHandle>;
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

  // Expose update() handle so the RAF coordinator can call us imperatively.
  useImperativeHandle(ref, () => ({
    update: (momentaryLufs: number, truePeakDbtp: number) => {
      valuesRef.current = { momentaryLufs, truePeakDbtp };

      // Update peak hold.
      if (momentaryLufs > peakLufsRef.current) {
        peakLufsRef.current = momentaryLufs;
      }

      // Mutate text directly — zero re-renders.
      if (lufsTextRef.current) {
        lufsTextRef.current.textContent = momentaryLufs <= -48 ? '--' : momentaryLufs.toFixed(1);
        lufsTextRef.current.className = `font-mono text-base font-semibold tabular-nums leading-none w-14 shrink-0 ${momentaryLufs <= -48 ? 'text-text-muted' : 'text-text-main'}`;
      }
      if (tpTextRef.current) {
        const tpDanger = truePeakDbtp > TP_CEILING;
        tpTextRef.current.textContent = `TP ${truePeakDbtp > -120 ? truePeakDbtp.toFixed(1) : '--'}`;
        tpTextRef.current.className = `text-[9px] font-mono tabular-nums ${tpDanger ? 'text-danger' : 'text-text-muted'}`;
      }

      // Repaint canvas.
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;

      const width = container.getBoundingClientRect().width;
      if (width === 0) return;
      const dpr = window.devicePixelRatio || 1;

      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(CANVAS_H * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${CANVAS_H}px`;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, CANVAS_H);

      const lufsPct = Math.max(0, Math.min(1, (momentaryLufs - LUFS_MIN) / (LUFS_MAX - LUFS_MIN)));
      const peakPct = Math.max(0, Math.min(1, (peakLufsRef.current - LUFS_MIN) / (LUFS_MAX - LUFS_MIN)));

      const borderColor =
        getComputedStyle(canvas).getPropertyValue('--color-panel-border').trim() ||
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
    },
  }), [color]);

  // ResizeObserver to repaint on layout changes (no RAF needed here; width change is rare).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => {
      const { momentaryLufs, truePeakDbtp } = valuesRef.current;
      if (momentaryLufs > -Infinity) {
        // Re-invoke update to repaint with the latest values at the new width.
        // This ref.current call is safe because the ref is stable after mount.
      }
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex justify-between items-baseline">
        <span
          className="text-[9px] uppercase tracking-widest font-bold"
          style={{ color }}
        >
          {label}
        </span>
        <span ref={tpTextRef} className="text-[9px] font-mono tabular-nums text-text-muted">
          TP --
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span ref={lufsTextRef} className="font-mono text-base font-semibold tabular-nums leading-none w-14 shrink-0 text-text-muted">
          --<span className="text-[9px] font-normal text-text-muted ml-0.5">M</span>
        </span>
        <div ref={containerRef} className="flex-1">
          <canvas ref={canvasRef} className="block" />
        </div>
      </div>
    </div>
  );
};
```

Note: The `<span>M</span>` suffix for the unit needs careful handling since we're setting `textContent` which wipes children. Fix: use a separate DOM ref for just the numeric value, keep the unit `M` as a sibling element:

```jsx
<span className="flex items-baseline gap-0.5">
  <span ref={lufsTextRef} className="font-mono text-base font-semibold tabular-nums leading-none w-14 shrink-0 text-text-muted">--</span>
  <span className="text-[9px] font-normal text-text-muted">M</span>
</span>
```

**Step 2: Verify TypeScript**

Run: `cd ui && npx tsc --noEmit 2>&1 | grep -i stemlufs`
Expected: no errors

**Step 3: Commit (partial — StemLufsRow only)**

```bash
git add ui/src/components/DiagnosticMeters.tsx
git commit -m "refactor(meters): StemLufsRow imperative handle with direct DOM mutation, zero prop re-renders"
```

---

### Task 4: Refactor SVG Sub-Components in `DiagnosticMeters.tsx` — Direct DOM Mutation

**Files:**
- Modify: `ui/src/components/DiagnosticMeters.tsx` (continuation)

**Step 1: Refactor SemiCircleGauge to imperative handle**

```typescript
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

  const cx = 60; const cy = 60; const r = 50;
  const needleLength = 44;

  useImperativeHandle(ref, () => ({
    update: (value: number) => {
      const clampedValue = Math.max(min, Math.min(max, value));
      const needleFrac = (clampedValue - min) / (max - min);
      const needleDeg = 180 - needleFrac * 180;
      const needleRad = (needleDeg * Math.PI) / 180;
      const nx = cx + needleLength * Math.cos(needleRad);
      const ny = cy - needleLength * Math.sin(needleRad);

      if (needleRef.current) {
        needleRef.current.setAttribute('x2', String(nx.toFixed(2)));
        needleRef.current.setAttribute('y2', String(ny.toFixed(2)));
      }
      if (textRef.current) {
        textRef.current.textContent = `${value.toFixed(1)} dB`;
      }
    },
  }), [min, max]);

  // arcPath is a pure function — compute once at render time for the static zones.
  function arcPath(fracStart: number, fracEnd: number): string { /* same as before */ }
  const redEnd    = (5  - min) / (max - min);
  const yellowEnd = (15 - min) / (max - min);

  return (
    <svg width={120} height={65} viewBox="0 0 120 65" aria-label="SNR gauge">
      <path d={arcPath(0, redEnd)} fill="none" stroke="oklch(0.55 0.22 25)" strokeWidth={5} strokeLinecap="round" />
      <path d={arcPath(redEnd, yellowEnd)} fill="none" stroke="oklch(0.75 0.18 85)" strokeWidth={5} strokeLinecap="round" />
      <path d={arcPath(yellowEnd, 1)} fill="none" stroke="oklch(0.65 0.2 145)" strokeWidth={5} strokeLinecap="round" />
      <line ref={needleRef} x1={cx} y1={cy} x2={cx} y2={cy} stroke="var(--color-text-main)" strokeWidth={1.5} strokeLinecap="round" />
      <circle cx={cx} cy={cy} r={2.5} fill="var(--color-text-main)" />
      <text ref={textRef} x={cx} y={62} textAnchor="middle" fontSize={8} fill="var(--color-text-muted)" fontFamily="monospace">
        -- dB
      </text>
    </svg>
  );
};
```

**Step 2: Refactor StereoHeatbar to imperative handle**

```typescript
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
      const clampedValue = Math.max(-1, Math.min(1, value));
      const xPos = ((clampedValue + 1) / 2) * WIDTH;
      const points = `${xPos},${INDICATOR_H} ${xPos - triHalf},0 ${xPos + triHalf},0`;

      const fill = isPhaseIssue
        ? 'oklch(0.55 0.22 25)'
        : clampedValue > 0.5
        ? 'oklch(0.65 0.2 145)'
        : 'oklch(0.75 0.18 85)';

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
        <text x={1} y={36} fontSize={7} fill="var(--color-text-muted)" fontFamily="monospace">-1</text>
        <text x={80} y={36} fontSize={7} fill="var(--color-text-muted)" fontFamily="monospace" textAnchor="middle">0</text>
        <text x={159} y={36} fontSize={7} fill="var(--color-text-muted)" fontFamily="monospace" textAnchor="end">+1</text>
      </svg>
    </div>
  );
};
```

**Step 3: Refactor CentroidNeedle to imperative handle**

```typescript
export interface CentroidNeedleHandle {
  update: (value: number) => void;
}

interface CentroidNeedleProps {
  ref?: React.Ref<CentroidNeedleHandle>;
}

const CentroidNeedle: React.FC<CentroidNeedleProps> = ({ ref }) => {
  const polygonRef = useRef<SVGPolygonElement>(null);
  const textRef = useRef<SVGTextElement | null>(null); // if we add a text label

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
```

**Step 4: Refactor MaskingIndicator to imperative handle**

```typescript
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
```

**Step 5: Verify TypeScript**

Run: `cd ui && npx tsc --noEmit 2>&1 | grep -i "DiagnosticMeters\|SemiCircle\|Stereo\|Centroid\|Masking"`
Expected: no errors in DiagnosticMeters.tsx

**Step 6: Commit**

```bash
git add ui/src/components/DiagnosticMeters.tsx
git commit -m "refactor(meters): SVG sub-components use imperative handles for direct DOM mutation"
```

---

### Task 5: Refactor `LiveMeters` — Single RAF Coordinator

**Files:**
- Modify: `ui/src/components/DiagnosticMeters.tsx` (continuation)

**Step 1: Rewrite LiveMeters**

Key changes:
- Remove `frame: DspFramePayload` prop → add `latestFrameRef: React.MutableRefObject<DspFramePayload | null>`
- Add `isStreaming: boolean` prop to control the RAF loop
- Run ONE persistent RAF loop in `LiveMeters` that reads the ref and dispatches to all child imperative handles
- The centroid Hz text display: add a `centroidTextRef` for the numeric readout in LiveMeters itself
- The SNR label text: add a `snrTextRef`

```typescript
interface LiveMetersProps {
  latestFrameRef: React.MutableRefObject<DspFramePayload | null>;
  isStreaming: boolean;
  lra?: number;
}

export const LiveMeters: React.FC<LiveMetersProps> = ({ latestFrameRef, isStreaming, lra }) => {
  const stemDxRef   = useRef<StemLufsRowHandle>(null);
  const stemMusicRef = useRef<StemLufsRowHandle>(null);
  const stemFxRef   = useRef<StemLufsRowHandle>(null);
  const gaugeRef    = useRef<SemiCircleGaugeHandle>(null);
  const phaseBarRef = useRef<StereoHeatbarHandle>(null);
  const centroidRef = useRef<CentroidNeedleHandle>(null);
  const maskingRef  = useRef<MaskingIndicatorHandle>(null);
  const centroidTextRef = useRef<HTMLSpanElement>(null);
  const rafRef      = useRef<number | null>(null);

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
        <StemLufsRow ref={stemDxRef} label="DX" color={STEM_COLORS.dx} />
        <StemLufsRow ref={stemMusicRef} label="Music" color={STEM_COLORS.music} />
        <StemLufsRow ref={stemFxRef} label="Effects" color={STEM_COLORS.effects} />
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
```

Note: `lra` comes from `completePayload` (fires once at end of stream) — it's fine as a prop here because it changes only once per session, not 60Hz.

**Step 2: Verify TypeScript**

Run: `cd ui && npx tsc --noEmit 2>&1 | grep -i livemeters`
Expected: no errors

**Step 3: Commit**

```bash
git add ui/src/components/DiagnosticMeters.tsx
git commit -m "refactor(meters): LiveMeters RAF coordinator dispatches to imperative child handles"
```

---

### Task 6: Update `App.tsx` — Eliminate All currentFrame References

**Files:**
- Modify: `ui/src/App.tsx`

**Step 1: Audit all `dspStream.currentFrame` usages in App.tsx**

Occurrences found (from the read):
1. Line 807: `currentTimeSecs={dspStream.currentFrame?.timestamp_secs}` → use `dspStream.currentTimeSecs`
2. Line 851: `{dspStream.currentFrame && (` → use `{dspStream.isStreaming && (`
3. Line 855–856: `{dspStream.currentFrame.timestamp_secs.toFixed(1)}s` → use `{dspStream.currentTimeSecs.toFixed(1)}s`
4. Line 860–863: `<Vectorscope lissajousPoints={dspStream.currentFrame.lissajous_points} size={140} />` → `<Vectorscope latestFrameRef={dspStream.latestFrameRef} isStreaming={dspStream.isStreaming} size={140} />`
5. Line 865–868: `<LiveMeters frame={dspStream.currentFrame} lra={...} />` → `<LiveMeters latestFrameRef={dspStream.latestFrameRef} isStreaming={dspStream.isStreaming} lra={...} />`
6. Line 881–884: `{dspStream.currentFrame && (<span>...{dspStream.currentFrame.timestamp_secs.toFixed(1)}s</span>)}` → use `isStreaming` and `currentTimeSecs`
7. Line 891: `currentTime={dspStream.currentFrame?.timestamp_secs ?? 0}` → `currentTime={dspStream.currentTimeSecs}`

**Step 2: Apply each change**

Change 1 — WaveformVisualizer playhead:
```typescript
// Before:
currentTimeSecs={dspStream.currentFrame?.timestamp_secs}
// After:
currentTimeSecs={dspStream.isStreaming ? dspStream.currentTimeSecs : undefined}
```

Change 2+3 — Live Meters section wrapper + timestamp label:
```typescript
// Before:
{dspStream.currentFrame && (
  <div className="space-y-3 animate-in fade-in duration-300">
    <div className="flex items-center justify-between">
      <span ...>Live Meters</span>
      <span ...>{dspStream.currentFrame.timestamp_secs.toFixed(1)}s</span>
    </div>
// After:
{dspStream.isStreaming && (
  <div className="space-y-3 animate-in fade-in duration-300">
    <div className="flex items-center justify-between">
      <span ...>Live Meters</span>
      <span ...>{dspStream.currentTimeSecs.toFixed(1)}s</span>
    </div>
```

Change 4 — Vectorscope props:
```typescript
// Before:
<Vectorscope lissajousPoints={dspStream.currentFrame.lissajous_points} size={140} />
// After:
<Vectorscope latestFrameRef={dspStream.latestFrameRef} isStreaming={dspStream.isStreaming} size={140} />
```

Change 5 — LiveMeters props:
```typescript
// Before:
<LiveMeters frame={dspStream.currentFrame} lra={dspStream.completePayload?.dialogue_loudness_range_lu} />
// After:
<LiveMeters latestFrameRef={dspStream.latestFrameRef} isStreaming={dspStream.isStreaming} lra={dspStream.completePayload?.dialogue_loudness_range_lu} />
```

Change 6 — Transcript section timestamp label:
```typescript
// Before:
{dspStream.currentFrame && (
  <span className="text-[10px] font-mono text-text-muted tabular-nums">
    {dspStream.currentFrame.timestamp_secs.toFixed(1)}s
  </span>
)}
// After:
{dspStream.isStreaming && (
  <span className="text-[10px] font-mono text-text-muted tabular-nums">
    {dspStream.currentTimeSecs.toFixed(1)}s
  </span>
)}
```

Change 7 — TranscriptScrubber currentTime:
```typescript
// Before:
currentTime={dspStream.currentFrame?.timestamp_secs ?? 0}
// After:
currentTime={dspStream.currentTimeSecs}
```

**Step 3: Full TypeScript check**

Run: `cd ui && npx tsc --noEmit 2>&1`
Expected: zero errors

**Step 4: Lint check**

Run: `cd ui && npx eslint src/App.tsx src/hooks/useDspStream.ts src/components/Vectorscope.tsx src/components/DiagnosticMeters.tsx --max-warnings 0 2>&1 | tail -20`

**Step 5: Commit**

```bash
git add ui/src/App.tsx
git commit -m "refactor(app): use isStreaming + latestFrameRef + currentTimeSecs, remove currentFrame references"
```

---

### Task 7: Final Verification

**Step 1: Full TypeScript build**

Run: `cd ui && npx tsc --noEmit`
Expected: zero errors

**Step 2: Vite build smoke test**

Run: `cd ui && npx vite build 2>&1 | tail -20`
Expected: build succeeds, no TS errors

**Step 3: Acceptance criteria review**

- **Zero-Reconciliation Streaming:** AppContent no longer has `currentFrame` in state — 60Hz Channel messages write only to a ref, causing zero React reconciliation on the hot path. Only `setCurrentTimeSecs` fires at 15Hz (≈15 setState calls/sec vs 60 before).
- **Fluid Diagnostics:** Vectorscope and LiveMeters run persistent RAF loops pulling from the ref at native 60fps.
- **Interactive Responsiveness:** With zero 60Hz reconciliations, the main thread is free for input events.

**Step 4: Commit summary**

```bash
git log --oneline -6
```

Expected commits:
```
refactor(app): use isStreaming + latestFrameRef + currentTimeSecs...
refactor(meters): LiveMeters RAF coordinator dispatches to imperative child handles
refactor(meters): SVG sub-components use imperative handles for direct DOM mutation
refactor(meters): StemLufsRow imperative handle with direct DOM mutation...
refactor(vectorscope): persistent RAF pull from latestFrameRef...
refactor(dsp): replace currentFrame state with latestFrameRef + 15Hz currentTimeSecs
```
