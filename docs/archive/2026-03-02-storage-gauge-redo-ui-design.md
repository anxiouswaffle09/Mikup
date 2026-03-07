# Storage Gauge & Redo UI — Design Document

**Date:** 2026-03-02
**Status:** Approved (autonomous)

---

## Problem Statement

Users have no visibility into available disk space before or during heavy ML processing (stem separation alone can produce 3–5x the source file size in stems). Additionally, there is no UI path to redo a specific pipeline stage: the existing `runStage(idx, force=true)` re-runs without invalidating downstream artifacts, leaving the project in a partially-stale state.

---

## Feature 1: Storage Gauge

### Architecture

**Rust command** (`ui/src-tauri/src/lib.rs`):
```rust
#[tauri::command]
async fn get_disk_info(path: String) -> Result<DiskInfo, String>
```

- **Crate:** `sysinfo` (added to `Cargo.toml`). Chosen over deprecated `fs2` and raw `statvfs` due to WSL2 compatibility and single unified API across macOS/Linux/Windows.
- **Logic:** Instantiate `sysinfo::Disks`, find the disk whose mount point is a prefix of `path`, return `DiskInfo { total_bytes, available_bytes, used_bytes }`.
- **Fallback:** If no matching disk found (e.g., WSL2 path mapping), return error string; UI shows "—" gracefully.

**TypeScript type:**
```typescript
interface DiskInfo {
  total_bytes: number;
  available_bytes: number;
  used_bytes: number;
}
```

**Component:** `ui/src/components/StorageGauge.tsx`
- Follows `StatCell` linear bar pattern from `DiagnosticMeters.tsx`
- Prop: `workspacePath: string`
- On mount: invokes `get_disk_info(workspacePath)`
- Re-queries: after each stage completion (App.tsx passes a `lastUpdated` timestamp prop)
- Display: horizontal progress bar (used/total), labels "X.X GB used of Y.Y GB (Z.Z GB free)"
- Color: green → yellow → red at 70%/90% used (matches existing OKLCH palette)

**Placement:** In `App.tsx`, landing view left panel, below the project history list. Also visible during processing view (same panel slot).

---

## Feature 2: Redo Stage Controls

### Architecture

**Redo cascade mapping** (mirrors `_stage_invalidation_paths` in `main.py`):
```
separation   → deletes: stems/, stems.json → cascades to: transcription, semantics, director
transcription → deletes: transcription.json → cascades to: semantics, director
dsp          → deletes: data/dsp_metrics.json → no Python call; re-runs generate_static_map
semantics    → deletes: semantics.json → cascades to: director
director     → deletes: mikup_payload.json, mikup_report.md, .mikup_context.md
```

**Rust command** (`ui/src-tauri/src/lib.rs`):
```rust
#[tauri::command]
async fn redo_pipeline_stage(
    output_directory: String,
    stage: String,
    input_path: String,
) -> Result<String, String>
```

- Validates `stage` ∈ `{separation, transcription, semantics, director}` (not `dsp`)
- Calls Python: `.venv/bin/python3 src/main.py --input <input_path> --output-dir <output_directory> --redo-stage <stage>`
- Returns stdout on success, stderr on failure

**DSP redo** is handled entirely in Rust/frontend:
- Delete `<output_dir>/data/dsp_metrics.json` via `std::fs::remove_file`
- Frontend calls `generate_static_map` after file removal

**Component:** `ui/src/components/RedoStageModal.tsx`
- Props: `stage: PipelineStageId | null`, `onConfirm: () => void`, `onClose: () => void`
- Shows: stage name, list of cascaded stages that will also be deleted
- Warning text: "This will permanently delete all data from [Stage] and every stage that follows. This cannot be undone."
- Two buttons: "Cancel" (grey) / "Redo [Stage]" (red destructive)

**Entry point:** Analysis view header (where file info + `StemControlStrip` live)
- A `[⟳ Re-process]` dropdown button
- Expands to show: `Redo Separation | Redo Transcription | Redo DSP | Redo Semantics | Redo Director`
- Each item disabled if stage was never completed

**App.tsx flow:**
1. `handleRedoStage(stage)` sets `redoTargetStage` state → opens `RedoStageModal`
2. On confirm: calls `redo_pipeline_stage` (or DSP path) → awaits success
3. Resets `completedStages` to stages before the redo target
4. Transitions to processing view, calls `runStage(stageIndex)` for the redo target

**UI state during redo:**
- While Python is invalidating: show "Clearing [Stage] data…" spinner in modal
- After success: modal closes, view transitions to processing with re-run in progress
- Transcript view, waveform, and metrics clear when their backing data is removed (existing null-guard rendering handles this)

---

## Component File Manifest

| File | Action |
|------|--------|
| `ui/src-tauri/Cargo.toml` | Add `sysinfo = "0.33"` |
| `ui/src-tauri/src/lib.rs` | Add `get_disk_info`, `redo_pipeline_stage`, `redo_dsp_stage` commands |
| `ui/src/components/StorageGauge.tsx` | New component |
| `ui/src/components/RedoStageModal.tsx` | New component |
| `ui/src/types.ts` | Add `DiskInfo` type |
| `ui/src/App.tsx` | Wire `StorageGauge`, `RedoStageModal`, `handleRedoStage` |

---

## Acceptance Criteria

1. `StorageGauge` displays correct available/used bytes for the workspace drive.
2. Gauge updates after each stage completes (via prop change, no polling).
3. Clicking "Redo Transcription" opens modal listing transcription + semantics + director as invalidated.
4. On confirm, Python invalidates artifacts and pipeline re-runs from transcription.
5. Transcript view and metrics clear immediately on redo (before re-run completes).
6. "Redo DSP" deletes dsp_metrics.json and re-runs generate_static_map without Python.
7. All buttons disabled (or stage entry hidden) when workspace path is not yet set.
