# Design: Pipeline Checkpointing & Resume System

**Date:** 2026-02-27
**Status:** Approved (user pre-approved full autonomous implementation)

---

## Overview

Add a robust checkpoint and resume system to the Mikup pipeline so that interrupted or partially-completed runs can be resumed without re-running earlier stages, and corrupted artifacts can be force-re-run on demand.

---

## Architecture

### 1. Rust: `get_pipeline_state` Command

**Location:** `ui/src-tauri/src/lib.rs`

New `#[tauri::command]` that accepts `output_directory: String` and reads `stage_state.json` from that directory. Returns the count of stages whose `completed` key is `true`, ordered by the canonical pipeline stage sequence: `separation → transcription → dsp → semantics → director`.

Returns an integer (not a map) so the frontend can directly set `completedStageCount`.

Must be registered in `tauri::generate_handler!`.

### 2. Rust: `--force` support in `run_pipeline_stage`

Add `force: Option<bool>` parameter to `run_pipeline_stage`. When `true`, append `--force` to the Python CLI args.

### 3. Frontend: State Recovery in `handleStartNewProcess`

**Location:** `ui/src/App.tsx`

After the user picks a workspace directory, call `get_pipeline_state`. If it returns N > 0, set `completedStageCount = N` and update `workflowMessage` to `"Previous progress found. Resuming from Stage {N+1}."`.

### 4. Frontend: Re-run Button for Completed Stages

In the processing view, change completed-stage rows to be clickable. Show label "Re-run" and a refresh icon. Clicking invokes `run_pipeline_stage` with `force: true` for that specific stage, then resets `completedStageCount` to `max(current, stageIndex + 1)`.

Actually: since re-running stage N doesn't invalidate stages N+1..end (artifacts remain), the force re-run simply re-runs that one stage and sets `completedStageCount` back to the index that was clicked (the stage just completed, so count = clickedIndex + 1). Keeps things simple.

### 5. Python: `validate_stage_artifacts(stage_name, output_dir)` Helper

**Location:** `src/main.py`

Per-stage validation logic:

| Stage | Validation |
|---|---|
| `separation` | `stems.json` exists, is a dict with `dialogue_raw`/`background_raw`, AND those WAV files exist on disk |
| `transcription` | `transcription.json` exists, is a dict with a `segments` list |
| `dsp` | `dsp_metrics.json` exists, is a non-empty dict |
| `semantics` | `semantics.json` exists, is a list (empty list is valid) |
| `director` | `mikup_payload.json` exists, is a non-empty dict |

Returns `True` if artifacts are valid, `False` otherwise.

### 6. Python: Smart Skipping Logic

Replace the simple existence checks (`validated_stems is None`, `_has_transcription_payload(...)`, etc.) with `validate_stage_artifacts()` calls.

A stage runs if:
- `--stage X` targets it explicitly **and** `--force` is not suppressing it (explicit stage always runs regardless of artifacts), OR
- Full pipeline **and** artifacts fail validation

### 7. Python: `--force` Flag

Add `--force` argparse argument. When `--force` is present alongside `--stage X`, the stage always runs even if artifacts are valid. When `--force` is present in full pipeline mode (no `--stage`), all stages run (clears the checkpoint effectively).

---

## Data Flow

```
User picks workspace
    → get_pipeline_state(workspace)
    → reads stage_state.json
    → counts completed stages in canonical order
    → returns N
    → App sets completedStageCount = N, shows resume message
```

```
User clicks Re-run on completed stage i
    → run_pipeline_stage(stage=i, force=true)
    → Python: --stage X --force
    → Stage re-runs unconditionally
    → completedStageCount updated
```

---

## Error Handling

- `get_pipeline_state` returns 0 if `stage_state.json` doesn't exist or is malformed (graceful no-op).
- `validate_stage_artifacts` returns `False` on any error (fail-safe: re-run rather than skip).
- `--force` on a non-existent stage in full pipeline mode is a no-op for other stages.

---

## Files Changed

| File | Change |
|---|---|
| `ui/src-tauri/src/lib.rs` | Add `get_pipeline_state`, add `force: Option<bool>` to `run_pipeline_stage` |
| `ui/src/App.tsx` | State recovery after workspace pick; Re-run button for completed stages |
| `src/main.py` | `validate_stage_artifacts()` helper; `--force` flag; smart skipping |
