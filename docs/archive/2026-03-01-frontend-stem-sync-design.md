# Frontend 5-Stem Architecture Sync

**Date:** 2026-03-01

## Problem

The frontend TypeScript types and application logic are out of sync with the backend's 5-stem architecture and stability refactor output. Three concrete issues:

1. `AudioArtifacts` interface doesn't model the new backend-written fields (`stage_state`, `stems`, `transcription`, `semantics`, `dsp_metrics`).
2. `MikupPayload` lacks `is_complete?: boolean`, so the analysis header can't signal a partial result.
3. The DSP stage completion path in `App.tsx` unconditionally calls `setView('analysis')` instead of gating on `nextCount >= PIPELINE_STAGES.length`. A re-run of DSP on an otherwise partial pipeline would prematurely enter the analysis view.
4. `handleSelectProject` (history load path) doesn't set `workspaceDirectory`/`inputPath`, so relative stem paths like `../../../../tmp/...` fail in `resolvePlaybackStemPaths` when the Rust DSP engine tries to open them.

## Design

### `types.ts`
- Expand `AudioArtifacts` with optional string fields: `stage_state`, `stems`, `transcription`, `semantics`, `dsp_metrics`.
- Add `is_complete?: boolean` to `MikupPayload`.
- In `parseMikupPayload`: parse `raw.is_complete` at the top level; parse the five new artifact path fields from `raw.artifacts`.

### `App.tsx`
- **DSP guard**: wrap the `setView('analysis')` call inside `if (nextCount >= PIPELINE_STAGES.length)`. If not complete, update message and stay in processing view.
- **Partial Result badge**: in the analysis view `<header>`, render a warning chip when `payload?.is_complete === false`.
- **History load fix**: in `handleSelectProject`, extract `output_dir` → `setWorkspaceDirectory` and `source_file` → `setInputPath` so `resolvePlaybackStemPaths` can construct correct absolute paths.

### `MetricsPanel.tsx`
No layout change needed — the Integrated/Peak LUFS box is already in its own `flex items-center` row below the chart.
