# Phase 4: Real-Time DSP Visualization — Design Document

**Date:** 2026-02-27
**Scope:** Frontend visualization layer for the Rust DSP engine. Implements the React side of the `stream_audio_metrics` / `stop_dsp_stream` Tauri commands already present in `ui/src-tauri/src/lib.rs`.

---

## Key Decisions

- **Rust replaces Python DSP.** When the user runs Stage 3 (Feature Extraction), `invoke('stream_audio_metrics', ...)` is called instead of `run_pipeline_stage` with `stage: 'dsp'`. Python's `src/dsp/processor.py` is no longer invoked for this stage.
- **React state for persistence.** On `dsp-complete`, integrated LUFS/LRA are merged into the in-memory `payload` state. No new disk-write command is needed. A thin `mark_dsp_complete` Tauri command writes DSP completion to `stage_state.json` so pipeline resume still works.
- **Approach: hook-centric, flat file structure.** One `useDspStream` hook owns all event listening. Components receive state as props. Matches the existing lean component style.

---

## New Files

| File | Purpose |
|---|---|
| `ui/src/hooks/useDspStream.ts` | Custom hook — registers Tauri event listeners, manages live stream state, exposes `startStream` / `stopStream` |
| `ui/src/components/Vectorscope.tsx` | HTML5 canvas goniometer — draws Lissajous points with neon-green glow |

## Modified Files

| File | Change |
|---|---|
| `ui/src/types.ts` | Add `DspFramePayload` and `DspCompletePayload` interfaces |
| `ui/src/components/DiagnosticMeters.tsx` | Add live-mode props; new meters for True Peak, LRA, Spectral Centroid, Masking |
| `ui/src/App.tsx` | DSP stage calls `startStream`; processing view shows `LiveMeteringView` when DSP is running; merges `dsp-complete` into payload state |

---

## TypeScript Types (`types.ts`)

### `DspFramePayload`
Matches `DspFramePayload` struct in `lib.rs`. Arrives ~60x/sec via the `dsp-frame` event during processing.

```ts
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
```

### `DspCompletePayload`
Matches `DspCompletePayload` struct in `lib.rs`. Emitted once via the `dsp-complete` event at natural EOF.

```ts
export interface DspCompletePayload {
  total_frames: number;
  dialogue_integrated_lufs: number;
  dialogue_loudness_range_lu: number;
  background_integrated_lufs: number;
  background_loudness_range_lu: number;
}
```

---

## Hook: `useDspStream.ts`

### State managed
```ts
currentFrame: DspFramePayload | null   // latest frame, updates ~60x/sec
completePayload: DspCompletePayload | null  // set once at natural EOF
isStreaming: boolean
error: string | null
```

### API
```ts
startStream(dialoguePath: string, backgroundPath: string): void
stopStream(): void
```

### Behaviour
- On mount: registers `listen('dsp-frame', ...)`, `listen('dsp-complete', ...)`, `listen('dsp-error', ...)`.
- `startStream`: sets `isStreaming = true`, resets `currentFrame` and `completePayload`, calls `invoke('stream_audio_metrics', { dialoguePath, backgroundPath })`.
- `listen('dsp-frame')`: updates `currentFrame` state.
- `listen('dsp-complete')`: sets `completePayload`, sets `isStreaming = false`.
- `listen('dsp-error')`: sets `error`, sets `isStreaming = false`.
- `stopStream`: calls `invoke('stop_dsp_stream')`, sets `isStreaming = false`.
- On unmount: unlisten all handlers, call `stopStream` if still streaming.

### Stem path resolution
`App.tsx` knows `inputPath` (the source audio file) and `workspaceDirectory`. It derives stem paths using the naming convention produced by Stage 1:
- Dialogue: `{workspaceDirectory}/{baseName}_Vocals.wav`
- Background: `{workspaceDirectory}/{baseName}_Instrumental.wav`

Where `baseName` is the input filename without extension.

---

## Component: `Vectorscope.tsx`

A fixed-size `<canvas>` (200×200px). Draws a professional goniometer ("spatial map") from Lissajous X/Y coordinate pairs.

### Rendering
- Background: `#0a0a0a` (near-black)
- Center cross and circle guide: `rgba(255,255,255,0.08)` (very faint)
- Points: `oklch(0.75 0.18 140)` — neon green, radius 1.5px, with `shadowBlur: 4` for glow
- Redraws via `useEffect` + `requestAnimationFrame` when `lissajousPoints` prop changes
- Does **not** trigger React re-renders on every frame — canvas is mutated imperatively

### Props
```ts
interface VectorscopeProps {
  lissajousPoints: [number, number][];
  size?: number; // default 200
}
```

---

## Component: `DiagnosticMeters.tsx`

### Two modes

**Static mode** (existing behaviour): receives `DiagnosticMetrics` from the finished payload. No change to existing `StatsBar` API.

**Live mode**: receives `currentFrame: DspFramePayload` and `completePayload: DspCompletePayload | null`. Shows real-time values.

### New meters in live mode

| Meter | Source | Notes |
|---|---|---|
| True Peak | `dialogue_true_peak_dbtp` | Range −12 to 0 dBTP; red zone above −1 |
| LRA | `dialogue_loudness_range_lu` from `completePayload` | Shows `--` during streaming |
| Spectral Centroid | `dialogue_centroid_hz` | Range 0–8000 Hz |
| MASKING | `speech_pocket_masked` | Red pill reading `MASKING` when true; grey when false |

All numeric values use `tabular-nums` font feature. Values transition smoothly with CSS `transition-all duration-150`.

---

## App.tsx Integration

### DSP stage override in `runStage`
When `stageIndex === 2` (DSP), instead of calling `run_pipeline_stage`:
1. Derive `dialoguePath` and `backgroundPath` from `inputPath` and `workspaceDirectory`
2. Call `startStream(dialoguePath, backgroundPath)`
3. Await stream completion by watching `completePayload` state

### `dsp-complete` handler
When `completePayload` is set:
1. Merge integrated LUFS/LRA into `payload` state:
   ```ts
   setPayload(prev => ({
     ...prev,
     metrics: {
       ...prev?.metrics,
       lufs_graph: {
         dialogue_raw: {
           integrated: completePayload.dialogue_integrated_lufs,
           momentary: [],
           short_term: [],
         },
         background_raw: {
           integrated: completePayload.background_integrated_lufs,
           momentary: [],
           short_term: [],
         },
       },
     },
   }));
   ```
2. Call `invoke('mark_dsp_complete', { outputDirectory: workspaceDirectory })` to update `stage_state.json`
3. Advance `completedStageCount` to 3

### LiveMeteringView layout (rendered when `runningStageIndex === 2`)
Replaces the stage list in the `processing` view:

```
┌─────────────────────────────────────────────────────┐
│  LIVE METERING — Feature Extraction (DSP)           │
│  ▶ frame 1,204  ·  00:51.2                          │
├─────────────────────┬───────────────────────────────┤
│                     │  SNR          18.4 dB         │
│   [Vectorscope]     │  Phase Corr   0.72            │
│   200 × 200 px      │  True Peak   -1.3 dBTP        │
│   neon green glow   │  Centroid    2,140 Hz         │
│                     │  LRA         --               │
│                     │  ● MASKING                    │
└─────────────────────┴───────────────────────────────┘
│  ████████████████░░░░░░░░░░  Processing...          │
└─────────────────────────────────────────────────────┘
```

The stage list reappears after the DSP stream completes (when `runningStageIndex` is no longer 2).

---

## New Rust Command Required

`mark_dsp_complete(output_directory: String)` — writes DSP stage completion to `stage_state.json` so `get_pipeline_state` correctly returns 3 after a Rust-driven DSP run. This is a thin file-write command with no audio processing.

---

## Out of Scope for This Phase

- Removing `src/dsp/processor.py` (deferred — Python DSP still runs for other pipeline paths)
- LRA history chart in `MetricsPanel` (deferred to a future MetricsPanel update)
- Audio playback during metering (no `cpal` integration)
