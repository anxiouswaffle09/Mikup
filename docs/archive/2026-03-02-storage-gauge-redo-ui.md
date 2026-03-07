# Storage Gauge & Redo UI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a real-time Storage Gauge (disk usage widget) and "Re-process" controls with confirmation modal to the Mikup Tauri desktop app.

**Architecture:** Two new Rust Tauri commands (`get_disk_info`, `redo_pipeline_stage`) backed by `sysinfo` and the existing `run_python_pipeline` helper; two new React components (`StorageGauge`, `RedoStageModal`) wired into `App.tsx`. Python's existing `--redo-stage` CLI flag does all artifact cleanup with no Python changes required.

**Tech Stack:** Rust (`sysinfo = "0.33"`), Tauri v2 commands, React + TypeScript, Tailwind v4 inline OKLCH

---

## Task 1: Add `sysinfo` to Cargo.toml

**Files:**
- Modify: `ui/src-tauri/Cargo.toml`

**Step 1: Add the dependency**

In `ui/src-tauri/Cargo.toml`, add `sysinfo` after the `chrono` line:

```toml
sysinfo = { version = "0.33", default-features = false, features = ["disk"] }
```

**Step 2: Verify it compiles**

```bash
cd ui && cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | head -20
```

Expected: warnings OK, no errors. `sysinfo` v0.33 crate resolves.

**Step 3: Commit**

```bash
git add ui/src-tauri/Cargo.toml ui/src-tauri/Cargo.lock
git commit -m "deps(rust): add sysinfo 0.33 for disk info query"
```

---

## Task 2: Add `DiskInfo` struct and `get_disk_info` command

**Files:**
- Modify: `ui/src-tauri/src/lib.rs`

**Step 1: Write a unit test (add inside the existing `#[cfg(test)] mod lib_tests` block at end of lib.rs, before the closing `}`)**

```rust
#[test]
fn disk_info_used_bytes_is_total_minus_available() {
    // Simulate the arithmetic used by get_disk_info
    let total: u64 = 500_000_000_000;
    let available: u64 = 200_000_000_000;
    let used = total.saturating_sub(available);
    assert_eq!(used, 300_000_000_000);
    // saturating_sub never panics when available > total (edge case on some VMs)
    let used_clamped = 0_u64.saturating_sub(1_u64);
    assert_eq!(used_clamped, 0);
}
```

**Step 2: Run test to verify it passes (it's pure arithmetic, no IO)**

```bash
cd ui && cargo test --manifest-path src-tauri/Cargo.toml disk_info 2>&1
```

Expected: `test lib_tests::disk_info_used_bytes_is_total_minus_available ... ok`

**Step 3: Add `DiskInfo` struct and `get_disk_info` command**

Add immediately before the `fn contains_unsafe_shell_tokens` function (around line 106 of lib.rs):

```rust
#[derive(Clone, serde::Serialize)]
struct DiskInfo {
    total_bytes: u64,
    available_bytes: u64,
    used_bytes: u64,
}

#[tauri::command]
async fn get_disk_info(path: String) -> Result<DiskInfo, String> {
    use sysinfo::Disks;

    let probe_path = if path.trim().is_empty() {
        std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "/".to_string())
    } else {
        path.clone()
    };

    let disks = Disks::new_with_refreshed_list();

    // Find the disk whose mount point is the longest matching prefix of our path.
    // This correctly handles WSL2 (/mnt/c, /mnt/d), macOS (/), and Linux mounts.
    let best = disks
        .iter()
        .filter(|d| {
            let mp = d.mount_point().to_string_lossy();
            probe_path.starts_with(mp.as_ref())
        })
        .max_by_key(|d| d.mount_point().to_string_lossy().len());

    match best {
        Some(disk) => {
            let total = disk.total_space();
            let available = disk.available_space();
            Ok(DiskInfo {
                total_bytes: total,
                available_bytes: available,
                used_bytes: total.saturating_sub(available),
            })
        }
        None => Err(format!("No disk found for path: {path}")),
    }
}
```

**Step 4: Verify it compiles**

```bash
cd ui && cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "^error"
```

Expected: no output (no errors).

**Step 5: Commit**

```bash
git add ui/src-tauri/src/lib.rs
git commit -m "feat(rust): add get_disk_info Tauri command via sysinfo"
```

---

## Task 3: Add `clear_dsp_stage_state` helper and `redo_pipeline_stage` command

**Files:**
- Modify: `ui/src-tauri/src/lib.rs`

**Step 1: Add unit test in lib_tests block**

```rust
#[test]
fn clear_dsp_stage_state_removes_dsp_key() {
    let initial = r#"{"stages":{"separation":{"completed":true},"dsp":{"completed":true},"transcription":{"completed":true}}}"#;
    let mut state: serde_json::Value = serde_json::from_str(initial).unwrap();
    if let Some(stages) = state.get_mut("stages").and_then(|s| s.as_object_mut()) {
        stages.remove("dsp");
    }
    assert!(state["stages"].get("dsp").is_none());
    assert_eq!(state["stages"]["separation"]["completed"].as_bool(), Some(true));
    assert_eq!(state["stages"]["transcription"]["completed"].as_bool(), Some(true));
}
```

**Step 2: Run test**

```bash
cd ui && cargo test --manifest-path src-tauri/Cargo.toml clear_dsp 2>&1
```

Expected: `test lib_tests::clear_dsp_stage_state_removes_dsp_key ... ok`

**Step 3: Add `clear_dsp_stage_state` helper and `redo_pipeline_stage` command**

Add immediately after the `mark_dsp_complete` command block (after line ~808 of lib.rs):

```rust
/// Remove the DSP stage entry from stage_state.json so `get_pipeline_state` correctly
/// reports DSP as incomplete after a redo. Called internally by `redo_pipeline_stage`.
async fn clear_dsp_stage_state(output_directory: &str) -> Result<(), String> {
    let state_path = resolve_data_artifact_path(output_directory, "stage_state.json")?;

    let content = match tokio::fs::read_to_string(&state_path).await {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };

    let mut state: serde_json::Value = serde_json::from_str(&content)
        .unwrap_or_else(|_| serde_json::json!({ "stages": {} }));

    if let Some(stages) = state.get_mut("stages").and_then(|s| s.as_object_mut()) {
        stages.remove("dsp");
    }

    let serialized = serde_json::to_string(&state).map_err(|e| e.to_string())?;
    tokio::fs::write(&state_path, serialized)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Invalidate a pipeline stage and all downstream stages, then re-run from that stage.
///
/// For non-DSP stages: delegates to Python `--redo-stage <stage>` which deletes artifacts
/// for the target stage and all downstream Python stages.
///
/// For the DSP stage: deletes `data/dsp_metrics.json` and clears DSP from `stage_state.json`
/// in Rust — no Python invocation. The frontend re-runs `generate_static_map` after this returns.
///
/// When redoing `separation` or `transcription`, DSP artifacts are also cleared (DSP is downstream
/// of both in the UI pipeline order: sep→trans→DSP→semantics→director).
#[tauri::command]
async fn redo_pipeline_stage(
    app: tauri::AppHandle,
    output_directory: String,
    stage: String,
    input_path: String,
) -> Result<String, String> {
    ensure_safe_argument("Output directory", &output_directory)?;
    ensure_safe_argument("Stage", &stage)?;

    let stage_lower = stage.trim().to_ascii_lowercase();
    let valid_stages = ["separation", "transcription", "dsp", "semantics", "director"];
    if !valid_stages.contains(&stage_lower.as_str()) {
        return Err(format!(
            "Invalid stage '{}'. Allowed: separation, transcription, dsp, semantics, director",
            stage
        ));
    }

    let output_path_buf = PathBuf::from(&output_directory);
    if !output_path_buf.is_absolute() {
        return Err("Output directory must be an absolute path".to_string());
    }

    // DSP-only redo: clear Rust artifacts and return — no Python call needed.
    if stage_lower == "dsp" {
        let dsp_metrics = resolve_data_artifact_path(&output_directory, "dsp_metrics.json")?;
        // Ignore not-found: file may already be missing.
        let _ = tokio::fs::remove_file(&dsp_metrics).await;
        clear_dsp_stage_state(&output_directory).await?;
        return Ok("DSP stage cleared. Re-run generate_static_map to regenerate.".to_string());
    }

    // For stages that precede DSP in pipeline order, also clear DSP Rust artifacts.
    // Python's --redo-stage does not know about the Rust DSP stage.
    if matches!(stage_lower.as_str(), "separation" | "transcription") {
        let dsp_metrics = resolve_data_artifact_path(&output_directory, "dsp_metrics.json")?;
        let _ = tokio::fs::remove_file(&dsp_metrics).await;
        // Non-fatal: if this fails, pipeline state may be slightly stale but re-run will fix it.
        let _ = clear_dsp_stage_state(&output_directory).await;
    }

    // Python stage redo.
    ensure_safe_argument("Input path", &input_path)?;
    let project_root =
        find_project_root(&app).ok_or_else(|| "Unable to resolve project root".to_string())?;

    let (_, output_directory_arg, _, output_path_arg) = resolve_output_paths(&output_directory)?;
    let input_path_arg = PathBuf::from(&input_path).to_string_lossy().into_owned();
    ensure_safe_argument("Input path", &input_path_arg)?;

    let mut args =
        build_base_pipeline_args(&input_path_arg, &output_directory_arg, &output_path_arg);
    args.extend(["--redo-stage".to_string(), stage_lower.clone()]);

    run_python_pipeline(&app, &project_root, args, 1200).await?;
    Ok(format!(
        "Stage {stage_lower} and all downstream stages have been cleared."
    ))
}
```

**Step 4: Register both new commands in the `invoke_handler` inside the `run()` function**

Find this block near the end of lib.rs:
```rust
        .invoke_handler(tauri::generate_handler![
            process_audio,
```

Add `get_disk_info,` and `redo_pipeline_stage,` to the list (before the closing `])`):
```rust
        .invoke_handler(tauri::generate_handler![
            process_audio,
            run_pipeline_stage,
            read_output_payload,
            get_stems,
            get_history,
            get_app_config,
            set_default_projects_dir,
            setup_project_workspace,
            get_pipeline_state,
            write_dsp_metrics,
            generate_static_map,
            stream_audio_metrics,
            stop_dsp_stream,
            set_stem_state,
            mark_dsp_complete,
            send_agent_message,
            get_disk_info,
            redo_pipeline_stage,
        ])
```

**Step 5: Run tests and build**

```bash
cd ui && cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | tail -10
cd ui && cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "^error"
```

Expected: all tests pass, no build errors.

**Step 6: Commit**

```bash
git add ui/src-tauri/src/lib.rs
git commit -m "feat(rust): add redo_pipeline_stage command with DSP cascade handling"
```

---

## Task 4: Add `DiskInfo` TypeScript type

**Files:**
- Modify: `ui/src/types.ts`

**Step 1: Add the interface**

At the end of the interfaces section in `ui/src/types.ts` (after `WorkspaceSetupResult`, before the `type PayloadRecord` line):

```typescript
export interface DiskInfo {
  total_bytes: number;
  available_bytes: number;
  used_bytes: number;
}
```

**Step 2: Verify TypeScript compiles**

```bash
cd ui && npm run lint 2>&1 | head -20
```

Expected: no new errors.

**Step 3: Commit**

```bash
git add ui/src/types.ts
git commit -m "feat(types): add DiskInfo interface for get_disk_info command"
```

---

## Task 5: Create `StorageGauge.tsx` component

**Files:**
- Create: `ui/src/components/StorageGauge.tsx`

**Step 1: Create the file**

Create `ui/src/components/StorageGauge.tsx` with this content:

```tsx
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { DiskInfo } from '../types';

function formatBytes(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

interface StorageGaugeProps {
  workspacePath: string;
  /** Bump this timestamp to trigger a re-query (e.g. after a stage completes). */
  lastUpdated?: number;
}

export function StorageGauge({ workspacePath, lastUpdated }: StorageGaugeProps) {
  const [diskInfo, setDiskInfo] = useState<DiskInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspacePath.trim()) return;
    invoke<DiskInfo>('get_disk_info', { path: workspacePath })
      .then((info) => {
        setDiskInfo(info);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(String(err));
      });
  }, [workspacePath, lastUpdated]);

  if (!workspacePath.trim()) return null;

  if (error) {
    return (
      <div className="px-4 py-3 border-t border-panel-border">
        <p className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-1">
          Storage
        </p>
        <p className="text-[10px] font-mono text-text-muted opacity-50">—</p>
      </div>
    );
  }

  if (!diskInfo) {
    return (
      <div className="px-4 py-3 border-t border-panel-border">
        <p className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-1">
          Storage
        </p>
        <div className="h-1.5 bg-panel-border rounded-full animate-pulse" />
      </div>
    );
  }

  const usedPct = diskInfo.total_bytes > 0 ? diskInfo.used_bytes / diskInfo.total_bytes : 0;
  // oklch color ramp: accent → amber at 70% → red at 90%
  const barColor =
    usedPct >= 0.9
      ? 'oklch(0.55 0.22 25)'
      : usedPct >= 0.7
        ? 'oklch(0.75 0.18 80)'
        : 'var(--color-accent)';

  return (
    <div className="px-4 py-3 border-t border-panel-border">
      <p className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-2">
        Storage
      </p>
      <div className="h-1.5 bg-panel-border rounded-full overflow-hidden mb-1.5">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${(usedPct * 100).toFixed(1)}%`, backgroundColor: barColor }}
        />
      </div>
      <div className="flex justify-between text-[9px] font-mono text-text-muted">
        <span>{formatBytes(diskInfo.used_bytes)} used</span>
        <span>{formatBytes(diskInfo.available_bytes)} free</span>
      </div>
    </div>
  );
}
```

**Step 2: Lint**

```bash
cd ui && npm run lint 2>&1 | head -20
```

Expected: no errors on the new file.

**Step 3: Commit**

```bash
git add ui/src/components/StorageGauge.tsx
git commit -m "feat(ui): add StorageGauge component with OKLCH color ramp"
```

---

## Task 6: Create `RedoStageModal.tsx` component

**Files:**
- Create: `ui/src/components/RedoStageModal.tsx`

**Step 1: Create the file**

Create `ui/src/components/RedoStageModal.tsx`:

```tsx
import type { PipelineStageDefinition } from '../types';

/**
 * Maps each stage (lowercase) to the human-readable names of all downstream stages
 * that will ALSO be invalidated when that stage is redone.
 * Mirrors the cascade logic in `redo_pipeline_stage` (Rust) and `--redo-stage` (Python).
 */
const STAGE_CASCADE: Record<string, string[]> = {
  separation: ['Transcription & Diarization', 'DSP', 'Semantics', 'AI Director'],
  transcription: ['DSP', 'Semantics', 'AI Director'],
  dsp: ['Semantics', 'AI Director'],
  semantics: ['AI Director'],
  director: [],
};

interface RedoStageModalProps {
  /** The stage to confirm redo for. Pass null to hide the modal. */
  stage: PipelineStageDefinition | null;
  onConfirm: () => void;
  onClose: () => void;
  isLoading?: boolean;
}

export function RedoStageModal({ stage, onConfirm, onClose, isLoading }: RedoStageModalProps) {
  if (!stage) return null;

  const stageKey = stage.id.toLowerCase();
  const cascade = STAGE_CASCADE[stageKey] ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="border border-panel-border bg-background max-w-sm w-full mx-4 p-6 space-y-5 animate-in fade-in duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <p className="text-[9px] uppercase tracking-widest font-bold text-red-400 mb-1">
            Destructive Action
          </p>
          <h3 className="text-base font-semibold text-text-main">Redo {stage.label}</h3>
        </div>

        <p className="text-[12px] font-mono text-text-muted leading-relaxed">
          This will permanently delete all data from{' '}
          <strong className="text-text-main">{stage.label}</strong>
          {cascade.length > 0 && (
            <>
              {' '}and every stage that follows:{' '}
              <strong className="text-text-main">{cascade.join(', ')}</strong>
            </>
          )}
          . This cannot be undone.
        </p>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isLoading}
            className="flex-1 border border-panel-border text-text-muted px-4 py-2.5 text-sm font-medium hover:border-text-muted transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isLoading}
            className="flex-1 border border-red-500/50 text-red-400 px-4 py-2.5 text-sm font-medium hover:bg-red-500/10 transition-colors disabled:opacity-40"
          >
            {isLoading ? 'Clearing…' : `Redo ${stage.label}`}
          </button>
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Lint**

```bash
cd ui && npm run lint 2>&1 | head -20
```

Expected: no errors.

**Step 3: Commit**

```bash
git add ui/src/components/RedoStageModal.tsx
git commit -m "feat(ui): add RedoStageModal confirmation component"
```

---

## Task 7: Wire `StorageGauge` + `RedoStageModal` into `App.tsx`

This task has several sub-steps. Read `ui/src/App.tsx` in full before editing.

**Files:**
- Modify: `ui/src/App.tsx`

### Step 1: Add imports

Find this block near the top of App.tsx:
```tsx
import { StemControlStrip } from './components/StemControlStrip';
```

Add after it:
```tsx
import { StorageGauge } from './components/StorageGauge';
import { RedoStageModal } from './components/RedoStageModal';
```

### Step 2: Add new state variables

Find this line in the `App()` function body:
```tsx
const [highlightAtSecs, setHighlightAtSecs] = useState<number | null>(null);
```

Add after it:
```tsx
const [redoTargetStage, setRedoTargetStage] = useState<PipelineStageDefinition | null>(null);
const [isRedoing, setIsRedoing] = useState(false);
const [showRedoMenu, setShowRedoMenu] = useState(false);
const [storageLastUpdated, setStorageLastUpdated] = useState(0);
```

### Step 3: Add `handleRedoStage` function

Find the `handleRerunStage` function:
```tsx
const handleRerunStage = async (stageIndex: number) => {
  await runStage(stageIndex, true);
};
```

Add this function after it:
```tsx
const handleRedoStage = async (stage: PipelineStageDefinition): Promise<void> => {
  if (!inputPath || !workspaceDirectory) return;

  setIsRedoing(true);
  try {
    await invoke<string>('redo_pipeline_stage', {
      outputDirectory: workspaceDirectory,
      stage: stage.id.toLowerCase(),
      inputPath,
    });

    const stageIndex = PIPELINE_STAGES.findIndex((s) => s.id === stage.id);
    // Reset completed count to the redo target so processing view re-runs from there.
    setCompletedStageCount(Math.min(completedStageCount, stageIndex));

    // Clear in-memory payload data for the invalidated stages.
    if (stage.id === 'SEPARATION') {
      setPayload(null);
    } else if (stage.id === 'TRANSCRIPTION' || stage.id === 'DSP') {
      setPayload((prev) =>
        prev
          ? {
              ...prev,
              transcription: undefined,
              metrics: {
                pacing_mikups: [],
                spatial_metrics: { total_duration: 0 },
                impact_metrics: {},
              },
            }
          : null,
      );
    } else if (stage.id === 'SEMANTICS') {
      setPayload((prev) => (prev ? { ...prev, semantics: undefined } : null));
    } else if (stage.id === 'DIRECTOR') {
      setPayload((prev) =>
        prev ? { ...prev, ai_report: undefined, is_complete: false } : null,
      );
    }

    setRedoTargetStage(null);
    setShowRedoMenu(false);
    setStorageLastUpdated(Date.now());
    setView('processing');
  } catch (err: unknown) {
    setError(err instanceof Error ? err.message : String(err));
  } finally {
    setIsRedoing(false);
  }
};
```

### Step 4: Add `StorageGauge` to the landing view

Find this block in the landing view return:
```tsx
  if (view === 'landing') {
    return (
      <div className="min-h-screen bg-background">
        <LandingHub
```

Replace the opening wrapper div with:
```tsx
  if (view === 'landing') {
    return (
      <div className="min-h-screen bg-background">
        <LandingHub
```
(same content) — then add the gauge and modal **inside the wrapper, after the error block**:

Find:
```tsx
        {error && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}
      </div>
    );
  }
```

Replace with:
```tsx
        {config?.default_projects_dir && (
          <div className="fixed bottom-4 left-4 w-52 shadow-lg">
            <StorageGauge
              workspacePath={config.default_projects_dir}
              lastUpdated={storageLastUpdated}
            />
          </div>
        )}
        {error && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}
      </div>
    );
  }
```

### Step 5: Add "Re-process" dropdown to the analysis view header

Find this block in the analysis view header (around line 653):
```tsx
        <div className="flex items-center gap-6">
          <StemControlStrip />
```

Replace with:
```tsx
        <div className="flex items-center gap-6">
          <StemControlStrip />
          {/* Re-process dropdown — only shown when workspace is available */}
          {workspaceDirectory && inputPath && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowRedoMenu((v) => !v)}
                className="text-[10px] font-mono text-text-muted hover:text-text-main border border-panel-border px-3 py-1.5 transition-colors"
              >
                Re-process ▾
              </button>
              {showRedoMenu && (
                <div className="absolute right-0 top-full mt-1 border border-panel-border bg-background z-20 min-w-[200px] shadow-lg">
                  {PIPELINE_STAGES.map((stage) => (
                    <button
                      key={stage.id}
                      type="button"
                      onClick={() => {
                        setRedoTargetStage(stage);
                        setShowRedoMenu(false);
                      }}
                      className="w-full text-left px-4 py-2.5 text-[11px] font-mono text-text-muted hover:text-text-main hover:bg-panel-border/30 transition-colors"
                    >
                      Redo {stage.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
```

### Step 6: Add `RedoStageModal` overlay to the analysis view return

Find the very end of the analysis view `return (` — the closing `</div>` that closes the root `<div className="min-h-screen ...">`. Add the modal just before it:

Find the last two lines of the analysis view:
```tsx
      </div>
    </div>
  );
```

The analysis view renders many nested divs. Find the absolute last `</div>` before the `);` at the end of the return and add the modal before it:

```tsx
      <RedoStageModal
        stage={redoTargetStage}
        onConfirm={() => {
          if (redoTargetStage) void handleRedoStage(redoTargetStage);
        }}
        onClose={() => setRedoTargetStage(null)}
        isLoading={isRedoing}
      />
    </div>
  );
```

**Step 7: Lint**

```bash
cd ui && npm run lint 2>&1
```

Expected: no errors. Fix any unused import warnings if present.

**Step 8: Commit**

```bash
git add ui/src/App.tsx
git commit -m "feat(ui): wire StorageGauge + RedoStageModal into App.tsx"
```

---

## Task 8: Final verification

**Step 1: Run Rust tests**

```bash
cd ui && cargo test --manifest-path src-tauri/Cargo.toml 2>&1
```

Expected: all tests pass including the two new ones.

**Step 2: Run TypeScript lint**

```bash
cd ui && npm run lint 2>&1
```

Expected: no errors.

**Step 3: Build Rust (catch any compilation errors)**

```bash
cd ui && cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "^error"
```

Expected: no output.

**Step 4: Commit any lint fixes and final state**

```bash
git add -u
git status
# Only commit if there are staged changes
git commit -m "chore: address lint warnings from StorageGauge/RedoStageModal integration"
```

---

## Summary of Changes

| File | Change |
|------|--------|
| `ui/src-tauri/Cargo.toml` | Add `sysinfo = "0.33"` |
| `ui/src-tauri/src/lib.rs` | Add `DiskInfo`, `get_disk_info`, `clear_dsp_stage_state`, `redo_pipeline_stage`; register both in `invoke_handler` |
| `ui/src/types.ts` | Add `DiskInfo` interface |
| `ui/src/components/StorageGauge.tsx` | New: linear progress bar with OKLCH color ramp |
| `ui/src/components/RedoStageModal.tsx` | New: confirmation modal with cascade list |
| `ui/src/App.tsx` | Add imports, state, `handleRedoStage`, storage gauge in landing, redo dropdown in analysis header, modal overlay |

**No Python changes required** — `--redo-stage` already exists in `src/main.py`.
