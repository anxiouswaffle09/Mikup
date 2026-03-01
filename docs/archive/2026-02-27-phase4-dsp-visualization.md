# Phase 4: Real-Time DSP Visualization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire the existing Rust DSP streaming engine to a live React visualization layer, replacing the Python DSP stage with Rust-driven real-time metering during Stage 3.

**Architecture:** A `useDspStream` hook owns all Tauri event subscriptions (`dsp-frame`, `dsp-complete`, `dsp-error`) and exposes `startStream`/`stopStream`. `App.tsx` intercepts the DSP pipeline stage (index 2) to call `startStream` instead of Python, switches the processing view to a `LiveMeteringView` (Vectorscope canvas + live DiagnosticMeters), and merges integrated metrics into React state on `dsp-complete`. A new `mark_dsp_complete` Rust command updates `stage_state.json` so pipeline resume still works.

**Tech Stack:** React 19, TypeScript, Tailwind v4, Tauri v2 (`@tauri-apps/api/event` `listen`, `@tauri-apps/api/core` `invoke`), HTML5 Canvas API, Rust (`serde_json`, `tokio::fs`).

**Design doc:** `docs/plans/2026-02-27-phase4-dsp-visualization-design.md`

---

## Prerequisites

- Stage 1 (Separation) must have run once so WAV stems exist in the workspace directory. The Rust `stream_audio_metrics` command opens files; if they don't exist it returns a `dsp-error` event.
- Rust toolchain and `cargo` available for `ui/src-tauri/`.
- Node/npm available for `ui/`.

---

## Task 1: Add `mark_dsp_complete` Tauri command (Rust)

**Why first:** Every other task is pure frontend. This is the only Rust change and needs a `cargo build` to verify. Get it out of the way early.

**Files:**
- Modify: `ui/src-tauri/src/lib.rs`

---

**Step 1: Add the command function**

In `ui/src-tauri/src/lib.rs`, add this new function **before** the `pub fn run()` block (e.g. after `get_pipeline_state`):

```rust
/// Marks the DSP stage as complete in `stage_state.json`.
/// Called by the frontend after the Rust `stream_audio_metrics` stream ends naturally.
/// This allows `get_pipeline_state` to correctly report 3 completed stages on resume.
#[tauri::command]
async fn mark_dsp_complete(output_directory: String) -> Result<(), String> {
    ensure_safe_argument("Output directory", &output_directory)?;

    let state_path = PathBuf::from(&output_directory).join("stage_state.json");

    let mut state: serde_json::Value = if state_path.exists() {
        let content = tokio::fs::read_to_string(&state_path)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::from_str(&content)
            .unwrap_or_else(|_| serde_json::json!({ "stages": {} }))
    } else {
        serde_json::json!({ "stages": {} })
    };

    state["stages"]["dsp"] = serde_json::json!({ "completed": true });

    let serialized = serde_json::to_string(&state).map_err(|e| e.to_string())?;
    tokio::fs::write(&state_path, serialized)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}
```

---

**Step 2: Register the command in `invoke_handler!`**

Find the existing `tauri::generate_handler![...]` call at the bottom of `lib.rs` and add `mark_dsp_complete`:

```rust
.invoke_handler(tauri::generate_handler![
    process_audio,
    run_pipeline_stage,
    read_output_payload,
    get_history,
    get_pipeline_state,
    stream_audio_metrics,
    stop_dsp_stream,
    mark_dsp_complete,   // ← add this
])
```

---

**Step 3: Verify it compiles**

```bash
cd ui/src-tauri && cargo check 2>&1
```

Expected: no errors. Warnings about unused imports are fine.

---

**Step 4: Write a Rust unit test**

Add this test at the bottom of `lib.rs` inside a `#[cfg(test)]` block (or append to any existing one):

```rust
#[cfg(test)]
mod lib_tests {
    use std::io::Write;
    use tempfile::NamedTempFile;

    // Sanity-check the JSON merge logic used by mark_dsp_complete in isolation.
    #[test]
    fn stage_state_json_merge() {
        let existing = serde_json::json!({
            "stages": {
                "separation": { "completed": true },
                "transcription": { "completed": true }
            }
        });
        let mut state = existing.clone();
        state["stages"]["dsp"] = serde_json::json!({ "completed": true });

        assert_eq!(
            state["stages"]["separation"]["completed"].as_bool(),
            Some(true)
        );
        assert_eq!(
            state["stages"]["dsp"]["completed"].as_bool(),
            Some(true)
        );
        // Transcription must not be wiped
        assert_eq!(
            state["stages"]["transcription"]["completed"].as_bool(),
            Some(true)
        );
    }
}
```

> **Note:** `tempfile` may not be in `Cargo.toml`. If it isn't, add it as a `[dev-dependency]`: `tempfile = "3"`. The test above doesn't actually use `tempfile` directly (it's just a unit test of the JSON logic) so you can omit the import if cargo complains.

---

**Step 5: Run the test**

```bash
cd ui/src-tauri && cargo test lib_tests 2>&1
```

Expected: `test lib_tests::stage_state_json_merge ... ok`

---

**Step 6: Commit**

```bash
cd ui && git add src-tauri/src/lib.rs
git commit -m "feat(rust): add mark_dsp_complete command for stage state persistence"
```

---

## Task 2: Add TypeScript types for DSP events

**Files:**
- Modify: `ui/src/types.ts`

---

**Step 1: Add the two interfaces**

Open `ui/src/types.ts`. After the `DiagnosticMetrics` interface (line ~45), add:

```ts
/**
 * Emitted by the `dsp-frame` Tauri event at up to 60 FPS during stream_audio_metrics.
 * Matches the DspFramePayload struct in ui/src-tauri/src/lib.rs exactly.
 */
export interface DspFramePayload {
  frame_index: number;
  timestamp_secs: number;
  // Loudness — dialogue stem
  dialogue_momentary_lufs: number;
  dialogue_short_term_lufs: number;
  dialogue_true_peak_dbtp: number;
  dialogue_crest_factor: number;
  // Loudness — background stem
  background_momentary_lufs: number;
  background_short_term_lufs: number;
  background_true_peak_dbtp: number;
  background_crest_factor: number;
  // Spatial
  phase_correlation: number;
  lissajous_points: [number, number][]; // [x, y] pairs, max 128 per frame
  // Spectral
  dialogue_centroid_hz: number;
  background_centroid_hz: number;
  speech_pocket_masked: boolean;
  snr_db: number;
}

/**
 * Emitted by the `dsp-complete` Tauri event once at natural EOF.
 * Matches the DspCompletePayload struct in ui/src-tauri/src/lib.rs exactly.
 */
export interface DspCompletePayload {
  total_frames: number;
  dialogue_integrated_lufs: number;
  dialogue_loudness_range_lu: number;
  background_integrated_lufs: number;
  background_loudness_range_lu: number;
}
```

---

**Step 2: Verify TypeScript compiles**

```bash
cd ui && npm run lint 2>&1
```

Expected: no new errors. (Warnings about unused types are fine — they'll be used in later tasks.)

---

**Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add DspFramePayload and DspCompletePayload interfaces"
```

---

## Task 3: Create `useDspStream` hook

**Files:**
- Create: `ui/src/hooks/useDspStream.ts`

---

**Step 1: Create the hooks directory and file**

```bash
mkdir -p ui/src/hooks
touch ui/src/hooks/useDspStream.ts
```

---

**Step 2: Write the hook**

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import type { DspCompletePayload, DspFramePayload } from '../types';

export interface UseDspStreamReturn {
  currentFrame: DspFramePayload | null;
  completePayload: DspCompletePayload | null;
  isStreaming: boolean;
  error: string | null;
  startStream: (dialoguePath: string, backgroundPath: string) => void;
  stopStream: () => void;
}

export function useDspStream(): UseDspStreamReturn {
  const [currentFrame, setCurrentFrame] = useState<DspFramePayload | null>(null);
  const [completePayload, setCompletePayload] = useState<DspCompletePayload | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track unlisten fns so we can clean up on unmount.
  // We use a ref (not state) because we don't want cleanup changes to trigger re-renders.
  const unlistenersRef = useRef<Array<() => void>>([]);

  useEffect(() => {
    let cleanedUp = false;

    const setup = async () => {
      const unlistenFrame = await listen<DspFramePayload>('dsp-frame', (event) => {
        if (!cleanedUp) setCurrentFrame(event.payload);
      });
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
        unlistenersRef.current = [unlistenFrame, unlistenComplete, unlistenError];
      } else {
        // Component unmounted before setup resolved — immediately clean up.
        unlistenFrame();
        unlistenComplete();
        unlistenError();
      }
    };

    setup();

    return () => {
      cleanedUp = true;
      unlistenersRef.current.forEach((fn) => fn());
      unlistenersRef.current = [];
    };
  }, []);

  const startStream = useCallback((dialoguePath: string, backgroundPath: string) => {
    setCurrentFrame(null);
    setCompletePayload(null);
    setError(null);
    setIsStreaming(true);
    // Fire-and-forget: completion/errors come through Tauri events above.
    invoke<void>('stream_audio_metrics', { dialoguePath, backgroundPath }).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
      setIsStreaming(false);
    });
  }, []);

  const stopStream = useCallback(() => {
    invoke<void>('stop_dsp_stream').catch(() => {
      // Best-effort; ignore errors from stop
    });
    setIsStreaming(false);
  }, []);

  return { currentFrame, completePayload, isStreaming, error, startStream, stopStream };
}
```

---

**Step 3: Verify TypeScript compiles**

```bash
cd ui && npm run lint 2>&1
```

Expected: no errors.

---

**Step 4: Commit**

```bash
git add src/hooks/useDspStream.ts
git commit -m "feat(hook): add useDspStream for real-time Tauri DSP event subscription"
```

---

## Task 4: Create `Vectorscope.tsx` canvas component

**Files:**
- Create: `ui/src/components/Vectorscope.tsx`

---

**Step 1: Write the component**

```tsx
import { useEffect, useRef } from 'react';

interface VectorscopeProps {
  /** Lissajous X/Y pairs in [-1, 1] range. Max 128 points per frame from Rust. */
  lissajousPoints: [number, number][];
  /** Canvas size in px (renders as a square). Default: 200. */
  size?: number;
}

const NEON_GREEN = '#39ff14';
const GUIDE_COLOR = 'rgba(255, 255, 255, 0.06)';
const CROSS_COLOR = 'rgba(255, 255, 255, 0.10)';
const BACKGROUND = '#0a0a0a';

export function Vectorscope({ lissajousPoints, size = 200 }: VectorscopeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Cancel any pending frame before scheduling a new one.
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);

    rafRef.current = requestAnimationFrame(() => {
      const cx = size / 2;
      const cy = size / 2;
      const radius = cx * 0.88;

      // Background
      ctx.fillStyle = BACKGROUND;
      ctx.fillRect(0, 0, size, size);

      // Outer guide circle
      ctx.strokeStyle = GUIDE_COLOR;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();

      // Center cross
      ctx.strokeStyle = CROSS_COLOR;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy - radius);
      ctx.lineTo(cx, cy + radius);
      ctx.moveTo(cx - radius, cy);
      ctx.lineTo(cx + radius, cy);
      ctx.stroke();

      // Lissajous points
      ctx.shadowBlur = 6;
      ctx.shadowColor = NEON_GREEN;
      ctx.fillStyle = NEON_GREEN;

      for (const [x, y] of lissajousPoints) {
        // x/y are in [-1, 1]. Map to canvas pixel coords.
        const px = cx + x * radius;
        const py = cy - y * radius; // flip Y: canvas y grows downward
        ctx.beginPath();
        ctx.arc(px, py, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }

      // Reset shadow so it doesn't bleed onto the next paint
      ctx.shadowBlur = 0;
    });

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [lissajousPoints, size]);

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      aria-label="Vectorscope goniometer"
      style={{ display: 'block', background: BACKGROUND }}
    />
  );
}
```

---

**Step 2: Verify TypeScript compiles**

```bash
cd ui && npm run lint 2>&1
```

Expected: no errors.

---

**Step 3: Smoke-test in the browser**

Temporarily import and render `<Vectorscope lissajousPoints={[[0.5, 0.5], [-0.3, 0.7], [0, 0]]} />` anywhere in `App.tsx`, run `npm run dev`, and verify:
- A dark square with a faint circle and cross appears
- Three neon-green dots are visible with a glow
- Remove the temporary render before committing

---

**Step 4: Commit**

```bash
git add src/components/Vectorscope.tsx
git commit -m "feat(ui): add Vectorscope canvas goniometer component"
```

---

## Task 5: Upgrade `DiagnosticMeters.tsx` with live mode

**Files:**
- Modify: `ui/src/components/DiagnosticMeters.tsx`

The existing `StatsBar` stays **unchanged** — it's still used in the analysis view. Add a new `LiveMeters` export alongside it.

---

**Step 1: Add the `LiveMeters` component to `DiagnosticMeters.tsx`**

At the top of the file, add the new import:

```ts
import type { DspCompletePayload, DspFramePayload } from '../types';
```

Then add these exports at the **bottom** of the file (after all existing code):

```tsx
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
      <LiveStatCell
        label="SNR"
        value={frame.snr_db}
        unit="dB"
        min={-20}
        max={60}
        targets={[15]}
        targetLabel="Target > 15 dB"
      />
      <LiveStatCell
        label="Phase Correlation"
        value={frame.phase_correlation}
        unit=""
        min={-1}
        max={1}
        targets={[0.5]}
        targetLabel="Target > 0.5"
      />
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
      <LiveStatCell
        label="Centroid"
        value={frame.dialogue_centroid_hz}
        unit="Hz"
        min={0}
        max={8000}
        decimals={0}
      />
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

const LiveStatCell: React.FC<LiveStatCellProps> = ({
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

  return (
    <div className="flex flex-col gap-1">
      <span className="text-[9px] uppercase tracking-widest font-bold text-text-muted">{label}</span>
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
```

---

**Step 2: Verify TypeScript compiles**

```bash
cd ui && npm run lint 2>&1
```

Expected: no errors.

---

**Step 3: Commit**

```bash
git add src/components/DiagnosticMeters.tsx
git commit -m "feat(ui): add LiveMeters component with True Peak, LRA, Centroid, Masking indicator"
```

---

## Task 6: Integrate live metering into `App.tsx`

This is the largest task. Take it step by step.

**Files:**
- Modify: `ui/src/App.tsx`

---

**Step 1: Add imports**

At the top of `App.tsx`, add:

```tsx
import { useDspStream } from './hooks/useDspStream';
import { Vectorscope } from './components/Vectorscope';
import { LiveMeters } from './components/DiagnosticMeters';
import type { DspCompletePayload } from './types';
```

---

**Step 2: Define the DSP stage index constant**

Directly after the `PIPELINE_STAGES` array definition, add:

```ts
const DSP_STAGE_INDEX = PIPELINE_STAGES.findIndex((s) => s.id === 'DSP');
```

---

**Step 3: Add the stem path utility function**

Add this pure function outside the `App` component (e.g. near the other helper functions at the top of the file):

```ts
/**
 * Derive dialogue and background WAV stem paths from the source file and workspace.
 * Convention: Stage 1 (Separation) places stems as `{baseName}_Vocals.wav` and
 * `{baseName}_Instrumental.wav` in the workspace directory.
 *
 * NOTE: If Stage 1 produces differently named files (verify by inspecting the
 * workspace after a real Stage 1 run), update the suffixes here.
 */
function deriveStemPaths(inputPath: string, workspaceDir: string): [string, string] {
  const filename = inputPath.replace(/^.*[\\/]/, '');
  const baseName = filename.replace(/\.[^/.]+$/, '');
  return [
    `${workspaceDir}/${baseName}_Vocals.wav`,
    `${workspaceDir}/${baseName}_Instrumental.wav`,
  ];
}
```

---

**Step 4: Instantiate the hook inside the `App` component**

Inside the `App` function body, after the existing `useState` declarations, add:

```ts
const dspStream = useDspStream();
```

---

**Step 5: Handle `dsp-complete` — merge metrics into payload state**

Add a `useEffect` that watches `dspStream.completePayload` and fires when it becomes non-null:

```tsx
useEffect(() => {
  const complete: DspCompletePayload | null = dspStream.completePayload;
  if (!complete || runningStageIndex !== DSP_STAGE_INDEX) return;

  // Merge integrated LUFS/LRA into the in-memory payload so Stage 5 (AI Director) sees it.
  setPayload((prev) => ({
    ...prev,
    metrics: {
      pacing_mikups: prev?.metrics?.pacing_mikups ?? [],
      spatial_metrics: prev?.metrics?.spatial_metrics ?? { total_duration: 0 },
      impact_metrics: prev?.metrics?.impact_metrics ?? {},
      ...prev?.metrics,
      lufs_graph: {
        ...(prev?.metrics?.lufs_graph ?? {}),
        dialogue_raw: {
          integrated: complete.dialogue_integrated_lufs,
          momentary: prev?.metrics?.lufs_graph?.dialogue_raw?.momentary ?? [],
          short_term: prev?.metrics?.lufs_graph?.dialogue_raw?.short_term ?? [],
        },
        background_raw: {
          integrated: complete.background_integrated_lufs,
          momentary: prev?.metrics?.lufs_graph?.background_raw?.momentary ?? [],
          short_term: prev?.metrics?.lufs_graph?.background_raw?.short_term ?? [],
        },
      },
      diagnostic_meters: {
        intelligibility_snr: 0,         // populated by later payload read
        stereo_correlation: 0,
        stereo_balance: 0,
        ...(prev?.metrics?.diagnostic_meters ?? {}),
      },
    },
  }));

  // Persist stage completion so get_pipeline_state returns 3 on resume.
  if (workspaceDirectory) {
    invoke<void>('mark_dsp_complete', { outputDirectory: workspaceDirectory }).catch(() => {
      // Non-fatal — resume will re-trigger DSP if state file is missing.
    });
  }

  // Advance the pipeline.
  const nextCount = Math.max(completedStageCount, DSP_STAGE_INDEX + 1);
  setCompletedStageCount(nextCount);
  setRunningStageIndex(null);

  const nextStage = PIPELINE_STAGES[nextCount];
  if (nextStage) {
    setWorkflowMessage(`Feature extraction complete. Proceed to ${nextStage.label}?`);
  }
}, [dspStream.completePayload]); // eslint-disable-line react-hooks/exhaustive-deps
```

> **Note on the exhaustive-deps lint:** The effect intentionally only re-runs when `completePayload` changes. The other values (`runningStageIndex`, `workspaceDirectory`, etc.) are read from the outer closure and will be current at the time the effect fires. This is safe because `completePayload` is set exactly once per stream.

---

**Step 6: Override `runStage` for the DSP stage**

Inside the existing `runStage` function, add an early-return branch **before** the `try` block:

Find the line:
```ts
setRunningStageIndex(stageIndex);
```

And add this block immediately **after** it:

```ts
// DSP is handled entirely by the Rust stream — no Python invocation.
if (stageIndex === DSP_STAGE_INDEX) {
  if (!inputPath || !workspaceDirectory) return;
  const [dialoguePath, backgroundPath] = deriveStemPaths(inputPath, workspaceDirectory);
  setProgress({ stage: 'DSP', progress: 0, message: 'Starting live DSP analysis...' });
  dspStream.startStream(dialoguePath, backgroundPath);
  return; // Completion handled by the useEffect watching dspStream.completePayload
}
```

---

**Step 7: Handle DSP stream errors**

Add another `useEffect` to surface stream errors in the existing error UI:

```tsx
useEffect(() => {
  if (dspStream.error) {
    setError(`DSP stream error: ${dspStream.error}`);
    setRunningStageIndex(null);
    setWorkflowMessage('DSP analysis failed. Check that Stage 1 stems exist and retry.');
  }
}, [dspStream.error]);
```

---

**Step 8: Render the `LiveMeteringView` in the processing view**

Inside the `if (view === 'processing')` block, find the `<div className="space-y-3">` that renders the stage list. Wrap it so that when DSP is running, it shows the live metering panel instead:

Replace this block:
```tsx
<div className="space-y-3">
  {PIPELINE_STAGES.map((stage, i) => {
    // ... existing stage row JSX ...
  })}
</div>
```

With:
```tsx
{runningStageIndex === DSP_STAGE_INDEX ? (
  /* Live metering view — replaces the stage list while DSP streams */
  <div className="space-y-4 animate-in fade-in duration-300">
    <div className="flex items-center justify-between">
      <span className="text-[10px] uppercase tracking-widest font-bold text-text-muted">
        Live Metering
      </span>
      {dspStream.currentFrame && (
        <span className="text-[10px] font-mono text-text-muted tabular-nums">
          frame {dspStream.currentFrame.frame_index.toLocaleString()}
          &nbsp;·&nbsp;
          {dspStream.currentFrame.timestamp_secs.toFixed(1)}s
        </span>
      )}
    </div>

    {dspStream.currentFrame ? (
      <div className="flex gap-6">
        <Vectorscope
          lissajousPoints={dspStream.currentFrame.lissajous_points}
          size={200}
        />
        <div className="flex-1 min-w-0">
          <LiveMeters
            frame={dspStream.currentFrame}
            lra={dspStream.completePayload?.dialogue_loudness_range_lu}
          />
        </div>
      </div>
    ) : (
      <div className="flex items-center gap-2 text-sm text-text-muted">
        <Loader2 size={14} className="animate-spin text-accent" />
        <span>Opening audio stems…</span>
      </div>
    )}

    <button
      type="button"
      onClick={() => dspStream.stopStream()}
      className="text-[10px] font-mono text-text-muted hover:text-accent transition-colors"
    >
      Stop stream
    </button>
  </div>
) : (
  <div className="space-y-3">
    {PIPELINE_STAGES.map((stage, i) => {
      const isComplete = i < completedStageCount;
      const isRunning = i === runningStageIndex;
      const isReady = i === completedStageCount && runningStageIndex === null;

      return (
        <div
          key={stage.id}
          className={clsx(
            'flex items-center gap-3 transition-opacity duration-300',
            !isComplete && !isRunning && !isReady && 'opacity-35'
          )}
        >
          <div
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{
              backgroundColor:
                isComplete || isRunning || isReady
                  ? 'var(--color-accent)'
                  : 'var(--color-panel-border)',
            }}
          />
          <span className={clsx('text-sm transition-colors', (isRunning || isReady) ? 'text-text-main font-medium' : 'text-text-muted')}>
            {stage.label}
          </span>
          {isComplete ? (
            <button
              type="button"
              onClick={() => handleRerunStage(i)}
              disabled={runningStageIndex !== null}
              className="ml-auto text-[10px] font-mono text-text-muted hover:text-accent transition-colors disabled:opacity-40"
              title={`Re-run ${stage.label}`}
            >
              Re-run
            </button>
          ) : (
            <span className="ml-auto text-[10px] font-mono text-text-muted">
              {isRunning ? 'Running' : isReady ? 'Ready' : 'Locked'}
            </span>
          )}
          {isRunning && <Loader2 size={12} className="animate-spin text-accent" />}
        </div>
      );
    })}
  </div>
)}
```

---

**Step 9: Verify TypeScript compiles**

```bash
cd ui && npm run lint 2>&1
```

Expected: no new errors. If you see `dspStream` not in scope, ensure the hook call is inside the `App` function body.

---

**Step 10: End-to-end smoke test**

1. `cd ui && npm run tauri:wsl` (or `npm run tauri dev` on non-WSL)
2. Select an audio file and workspace that has already completed Stage 1 (stems exist)
3. Click **Run Feature Extraction (LUFS)**
4. Verify:
   - The stage list disappears and the Live Metering view appears
   - The Vectorscope canvas shows neon-green dots moving
   - The meters update with real values
   - When the stream ends, the stage list reappears and Stage 3 is marked complete
   - `stage_state.json` in the workspace now has `"dsp": {"completed": true}`

---

**Step 11: Commit**

```bash
git add src/App.tsx
git commit -m "feat(ui): integrate live DSP metering view — Rust stream replaces Python DSP stage"
```

---

## Done

The complete feature is implemented. Run the full pipeline on a real file to verify all stages (separation → transcription → DSP live metering → semantics → AI Director) flow correctly end-to-end.

**Final check:** Open the Analysis view after all stages complete. Verify that `Integrated LUFS` in the `StatsBar` shows the value emitted by `dsp-complete` (not `--`).
