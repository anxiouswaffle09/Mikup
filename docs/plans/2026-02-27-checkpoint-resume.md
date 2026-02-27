# Checkpoint & Resume System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add robust checkpointing and resume to the Mikup pipeline — validate artifacts before skipping stages, add `--force` to Python CLI, expose `get_pipeline_state` from Rust, and allow stage re-runs from the UI.

**Architecture:** Python gains artifact validation and `--force` flag for smart skipping; Rust gains a `get_pipeline_state` Tauri command that reads `stage_state.json`; App.tsx calls it after workspace selection to restore progress, and completed stages become re-runnable.

**Tech Stack:** Python 3.13, argparse, os.path; Rust / Tauri 2; React/TypeScript, @tauri-apps/api

---

### Task 1: Python — `validate_stage_artifacts` helper + tests

**Files:**
- Modify: `src/main.py` (add helper after `_has_semantics_payload`)
- Test: `tests/test_main_checkpoint.py` (new file)

**Step 1: Write failing tests**

Create `tests/test_main_checkpoint.py`:

```python
import json
import os
import tempfile
import pytest

# Allow importing from project root
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.main import validate_stage_artifacts


# ─── separation ───────────────────────────────────────────────────────────────

def test_separation_valid(tmp_path):
    # Create real WAV stubs so os.path.exists passes
    dialogue = tmp_path / "vocals.wav"
    background = tmp_path / "instru.wav"
    dialogue.write_bytes(b"RIFF")
    background.write_bytes(b"RIFF")

    stems_json = tmp_path / "stems.json"
    stems_json.write_text(json.dumps({
        "dialogue_raw": str(dialogue),
        "background_raw": str(background),
    }))

    assert validate_stage_artifacts("separation", str(tmp_path)) is True


def test_separation_missing_stems_json(tmp_path):
    assert validate_stage_artifacts("separation", str(tmp_path)) is False


def test_separation_wav_missing(tmp_path):
    stems_json = tmp_path / "stems.json"
    stems_json.write_text(json.dumps({
        "dialogue_raw": str(tmp_path / "nonexistent.wav"),
        "background_raw": str(tmp_path / "also_missing.wav"),
    }))
    assert validate_stage_artifacts("separation", str(tmp_path)) is False


# ─── transcription ────────────────────────────────────────────────────────────

def test_transcription_valid(tmp_path):
    (tmp_path / "transcription.json").write_text(json.dumps({"segments": []}))
    assert validate_stage_artifacts("transcription", str(tmp_path)) is True


def test_transcription_missing(tmp_path):
    assert validate_stage_artifacts("transcription", str(tmp_path)) is False


def test_transcription_bad_shape(tmp_path):
    (tmp_path / "transcription.json").write_text(json.dumps({"not_segments": 42}))
    assert validate_stage_artifacts("transcription", str(tmp_path)) is False


# ─── dsp ──────────────────────────────────────────────────────────────────────

def test_dsp_valid(tmp_path):
    (tmp_path / "dsp_metrics.json").write_text(json.dumps({"key": "value"}))
    assert validate_stage_artifacts("dsp", str(tmp_path)) is True


def test_dsp_empty_dict(tmp_path):
    (tmp_path / "dsp_metrics.json").write_text(json.dumps({}))
    assert validate_stage_artifacts("dsp", str(tmp_path)) is False


def test_dsp_missing(tmp_path):
    assert validate_stage_artifacts("dsp", str(tmp_path)) is False


# ─── semantics ────────────────────────────────────────────────────────────────

def test_semantics_valid_empty_list(tmp_path):
    # Empty list is a valid semantics artifact
    (tmp_path / "semantics.json").write_text(json.dumps([]))
    assert validate_stage_artifacts("semantics", str(tmp_path)) is True


def test_semantics_valid_with_tags(tmp_path):
    (tmp_path / "semantics.json").write_text(json.dumps([{"label": "rain", "score": 0.9}]))
    assert validate_stage_artifacts("semantics", str(tmp_path)) is True


def test_semantics_missing(tmp_path):
    assert validate_stage_artifacts("semantics", str(tmp_path)) is False


def test_semantics_wrong_type(tmp_path):
    (tmp_path / "semantics.json").write_text(json.dumps({"oops": "dict"}))
    assert validate_stage_artifacts("semantics", str(tmp_path)) is False


# ─── director ─────────────────────────────────────────────────────────────────

def test_director_valid(tmp_path):
    (tmp_path / "mikup_payload.json").write_text(json.dumps({"metadata": {}}))
    assert validate_stage_artifacts("director", str(tmp_path)) is True


def test_director_missing(tmp_path):
    assert validate_stage_artifacts("director", str(tmp_path)) is False


def test_director_empty(tmp_path):
    (tmp_path / "mikup_payload.json").write_text(json.dumps({}))
    assert validate_stage_artifacts("director", str(tmp_path)) is False


# ─── unknown stage ────────────────────────────────────────────────────────────

def test_unknown_stage_returns_false(tmp_path):
    assert validate_stage_artifacts("bogus", str(tmp_path)) is False
```

**Step 2: Run tests to verify they fail**

```bash
cd "/Users/test/Documents/Dev Projects/Mikup"
source .venv/bin/activate
python -m pytest tests/test_main_checkpoint.py -v 2>&1 | head -30
```

Expected: `ImportError: cannot import name 'validate_stage_artifacts' from 'src.main'`

**Step 3: Implement `validate_stage_artifacts` in `src/main.py`**

Add after the `_has_semantics_payload` function (around line 136):

```python
def validate_stage_artifacts(stage_name: str, output_dir: str) -> bool:
    """Return True if the given stage's output artifacts exist and are structurally valid."""
    try:
        if stage_name == "separation":
            stems_path = os.path.join(output_dir, "stems.json")
            stems = _read_json_file(stems_path)
            if not isinstance(stems, dict):
                return False
            for key in ("dialogue_raw", "background_raw"):
                wav_path = stems.get(key)
                if not isinstance(wav_path, str) or not os.path.exists(wav_path):
                    return False
            return True

        if stage_name == "transcription":
            path = os.path.join(output_dir, "transcription.json")
            payload = _read_json_file(path)
            return isinstance(payload, dict) and isinstance(payload.get("segments"), list)

        if stage_name == "dsp":
            path = os.path.join(output_dir, "dsp_metrics.json")
            payload = _read_json_file(path)
            return isinstance(payload, dict) and bool(payload)

        if stage_name == "semantics":
            path = os.path.join(output_dir, "semantics.json")
            payload = _read_json_file(path)
            return isinstance(payload, list)

        if stage_name == "director":
            path = os.path.join(output_dir, "mikup_payload.json")
            payload = _read_json_file(path)
            return isinstance(payload, dict) and bool(payload)

        return False
    except Exception:
        return False
```

**Step 4: Run tests to verify they pass**

```bash
python -m pytest tests/test_main_checkpoint.py -v
```

Expected: all green

**Step 5: Commit**

```bash
git add tests/test_main_checkpoint.py src/main.py
git commit -m "feat: add validate_stage_artifacts() helper with full test coverage"
```

---

### Task 2: Python — `--force` flag + smart skipping

**Files:**
- Modify: `src/main.py` — argparse + `should_run_*` logic

**Step 1: Write failing test for force-skipping logic**

Add to `tests/test_main_checkpoint.py`:

```python
# ─── CLI --force flag integration test ────────────────────────────────────────

import subprocess

def test_force_flag_accepted(tmp_path):
    """--force should be accepted without error (uses mock mode so no heavy deps)."""
    result = subprocess.run(
        [sys.executable, "src/main.py", "--input", "dummy", "--mock",
         "--stage", "separation", "--output-dir", str(tmp_path), "--force"],
        capture_output=True, text=True,
        cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    )
    # Exit 0 or non-zero is fine; what we test is that --force doesn't cause argparse error
    assert "unrecognized arguments" not in result.stderr
    assert "error: unrecognized" not in result.stderr
```

**Step 2: Run new test to verify it fails**

```bash
python -m pytest tests/test_main_checkpoint.py::test_force_flag_accepted -v
```

Expected: FAIL — "unrecognized arguments: --force"

**Step 3: Add `--force` to argparse and update `should_run_*` logic**

In `main()` in `src/main.py`, after the `--mock` argument line, add:

```python
parser.add_argument("--force", action="store_true", help="Force re-run even if artifacts exist")
```

Then replace the four `should_run_*` lines with:

```python
# Separation
should_run_separation = (
    (args.stage == "separation") or
    (full_pipeline and (args.force or not validate_stage_artifacts("separation", output_dir)))
)
```

```python
# Transcription
has_transcription = validate_stage_artifacts("transcription", output_dir) and not args.force
should_run_transcription = (args.stage == "transcription") or (full_pipeline and not has_transcription)
```

```python
# DSP
has_dsp_metrics = validate_stage_artifacts("dsp", output_dir) and not args.force
should_run_dsp = (args.stage == "dsp") or (full_pipeline and not has_dsp_metrics)
```

```python
# Semantics
has_semantics = validate_stage_artifacts("semantics", output_dir) and not args.force
should_run_semantics = (args.stage == "semantics") or (full_pipeline and not has_semantics)
```

Also update the existing check at line 401-405 (the `validated_stems` block):

```python
validated_stems = None
if not (args.stage == "separation" and args.force):
    try:
        validated_stems = normalize_and_validate_stems(stems)
    except (FileNotFoundError, ValueError):
        validated_stems = None
```

Note: When `--stage separation --force`, we always re-run, so skip the pre-validation.

**Step 4: Run all checkpoint tests**

```bash
python -m pytest tests/test_main_checkpoint.py -v
```

Expected: all pass

**Step 5: Commit**

```bash
git add src/main.py tests/test_main_checkpoint.py
git commit -m "feat: add --force flag and artifact-validated smart skipping to pipeline"
```

---

### Task 3: Rust — `get_pipeline_state` command

**Files:**
- Modify: `ui/src-tauri/src/lib.rs`

The canonical stage order matches the Python pipeline: `["separation", "transcription", "dsp", "semantics", "director"]`. A stage counts as complete only if its entry in `stages` has `"completed": true` AND all preceding stages are also complete (no gaps).

**Step 1: Add `get_pipeline_state` function and command**

Add before the `#[cfg_attr(mobile, tauri::mobile_entry_point)]` line in `lib.rs`:

```rust
#[tauri::command]
async fn get_pipeline_state(output_directory: String) -> Result<u32, String> {
    ensure_safe_argument("Output directory", &output_directory)?;

    let state_path = PathBuf::from(&output_directory).join("stage_state.json");

    if !state_path.exists() {
        return Ok(0);
    }

    let content = tokio::fs::read_to_string(&state_path)
        .await
        .map_err(|e| e.to_string())?;

    let state: serde_json::Value = serde_json::from_str(&content).unwrap_or(serde_json::Value::Null);

    let stages_map = match state.get("stages").and_then(|s| s.as_object()) {
        Some(m) => m,
        None => return Ok(0),
    };

    let canonical_order = ["separation", "transcription", "dsp", "semantics", "director"];
    let mut count = 0u32;
    for stage_name in canonical_order.iter() {
        let completed = stages_map
            .get(*stage_name)
            .and_then(|s| s.get("completed"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if completed {
            count += 1;
        } else {
            break; // stop at first gap — no holes
        }
    }

    Ok(count)
}
```

**Step 2: Register it in `tauri::generate_handler!`**

Change:
```rust
.invoke_handler(tauri::generate_handler![
    process_audio,
    run_pipeline_stage,
    read_output_payload,
    get_history
])
```
To:
```rust
.invoke_handler(tauri::generate_handler![
    process_audio,
    run_pipeline_stage,
    read_output_payload,
    get_history,
    get_pipeline_state
])
```

**Step 3: Add `force: Option<bool>` to `run_pipeline_stage`**

In the `run_pipeline_stage` function signature, add parameter after `fast_mode`:

```rust
force: Option<bool>,
```

After the `if fast_mode.unwrap_or(false)` block, add:

```rust
if force.unwrap_or(false) {
    args.push("--force".to_string());
}
```

**Step 4: Verify Rust compiles**

```bash
cd "/Users/test/Documents/Dev Projects/Mikup/ui"
cargo build 2>&1 | tail -20
```

Expected: `Finished` with no errors.

**Step 5: Commit**

```bash
cd "/Users/test/Documents/Dev Projects/Mikup"
git add ui/src-tauri/src/lib.rs
git commit -m "feat: add get_pipeline_state Tauri command; add force param to run_pipeline_stage"
```

---

### Task 4: Frontend — State recovery after workspace selection

**Files:**
- Modify: `ui/src/App.tsx`

**Step 1: Update `handleStartNewProcess` to call `get_pipeline_state`**

Replace the current block (lines 99–105, after `setWorkspaceDirectory(selectedDirectory)`):

```typescript
setInputPath(filePath);
setWorkspaceDirectory(selectedDirectory);
setCompletedStageCount(0);
setRunningStageIndex(null);
setWorkflowMessage('Workspace selected. Run Stage 1: Surgical Separation.');
setProgress({ stage: 'INIT', progress: 0, message: 'Ready to run stage 1.' });
setView('processing');
```

With:

```typescript
setInputPath(filePath);
setWorkspaceDirectory(selectedDirectory);
setRunningStageIndex(null);

let resumeCount = 0;
try {
  resumeCount = await invoke<number>('get_pipeline_state', {
    outputDirectory: selectedDirectory,
  });
} catch {
  // non-fatal: treat as fresh start
  resumeCount = 0;
}

setCompletedStageCount(resumeCount);

if (resumeCount > 0 && resumeCount < PIPELINE_STAGES.length) {
  const nextStage = PIPELINE_STAGES[resumeCount];
  setWorkflowMessage(
    `Previous progress found. Resuming from Stage ${resumeCount + 1}: ${nextStage.label}.`
  );
  setProgress({ stage: 'INIT', progress: 0, message: `Resuming from stage ${resumeCount + 1}.` });
} else if (resumeCount >= PIPELINE_STAGES.length) {
  setWorkflowMessage('All stages previously completed. Re-run any stage or view results.');
  setProgress({ stage: 'COMPLETE', progress: 100, message: 'Previously completed.' });
} else {
  setWorkflowMessage('Workspace selected. Run Stage 1: Surgical Separation.');
  setProgress({ stage: 'INIT', progress: 0, message: 'Ready to run stage 1.' });
}

setView('processing');
```

**Step 2: Verify the frontend builds without errors**

```bash
cd "/Users/test/Documents/Dev Projects/Mikup/ui"
npm run build 2>&1 | tail -20
```

Expected: No TypeScript errors.

**Step 3: Commit**

```bash
cd "/Users/test/Documents/Dev Projects/Mikup"
git add ui/src/App.tsx
git commit -m "feat: restore pipeline progress on workspace selection via get_pipeline_state"
```

---

### Task 5: Frontend — Re-run button for completed stages

**Files:**
- Modify: `ui/src/App.tsx`

**Step 1: Add `runStage` overload support for force re-run**

Update the `runStage` function signature to accept an optional `force` boolean:

```typescript
const runStage = async (stageIndex: number, force = false): Promise<void> => {
```

Update the `invoke` call inside `runStage`:

```typescript
await invoke<string>('run_pipeline_stage', {
  inputPath,
  outputDirectory: workspaceDirectory,
  stage: stage.id,
  fastMode,
  force,
});
```

After the `setCompletedStageCount(nextCompletedCount)` line, add special handling when force re-running a stage that wasn't the "next" one (i.e., stageIndex < completedStageCount):

```typescript
const nextCompletedCount = Math.max(completedStageCount, stageIndex + 1);
setCompletedStageCount(nextCompletedCount);
```

Replace the existing `const nextCompletedCount = stageIndex + 1;` line with the above.

**Step 2: Add Re-run handler**

Add this function after `handleRunNextStage`:

```typescript
const handleRerunStage = async (stageIndex: number) => {
  await runStage(stageIndex, true);
};
```

**Step 3: Update the stage list UI to show Re-run for completed stages**

In the `PIPELINE_STAGES.map` block, replace the status span and loader:

```tsx
<span className="ml-auto text-[10px] font-mono text-text-muted">
  {isComplete ? 'Complete' : isRunning ? 'Running' : isReady ? 'Ready' : 'Locked'}
</span>
{isRunning && <Loader2 size={12} className="animate-spin text-accent" />}
```

With:

```tsx
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
```

**Step 4: Verify build**

```bash
cd "/Users/test/Documents/Dev Projects/Mikup/ui"
npm run build 2>&1 | tail -20
```

Expected: No errors.

**Step 5: Lint**

```bash
npm run lint 2>&1 | tail -20
```

Expected: No errors or only pre-existing warnings.

**Step 6: Commit**

```bash
cd "/Users/test/Documents/Dev Projects/Mikup"
git add ui/src/App.tsx
git commit -m "feat: add Re-run button for completed pipeline stages with --force support"
```

---

### Task 6: End-to-end smoke test

**Step 1: Run all Python checkpoint tests**

```bash
cd "/Users/test/Documents/Dev Projects/Mikup"
source .venv/bin/activate
python -m pytest tests/test_main_checkpoint.py -v
```

Expected: All pass.

**Step 2: Run mock pipeline with validation**

```bash
python src/main.py --input dummy --mock --output-dir /tmp/mikup_test_resume
```

Expected: completes, writes `stage_state.json` to `/tmp/mikup_test_resume/`.

**Step 3: Confirm stage_state.json is valid**

```bash
python -c "
import json
with open('/tmp/mikup_test_resume/stage_state.json') as f:
    s = json.load(f)
stages = s.get('stages', {})
for name, info in stages.items():
    print(name, '->', info.get('completed'))
"
```

Expected: all stages print `True`.

**Step 4: Run again without --force — all stages should skip**

```bash
python src/main.py --input dummy --mock --output-dir /tmp/mikup_test_resume 2>&1 | grep "existing"
```

Expected: lines mentioning "Using existing … artifact" for each stage.

**Step 5: Run with --force — all stages should re-run**

```bash
python src/main.py --input dummy --mock --output-dir /tmp/mikup_test_resume --force 2>&1 | grep -v "existing"
```

Expected: No "Using existing" messages — stages all re-ran.

**Step 6: Validate Rust compilation one more time**

```bash
cd "/Users/test/Documents/Dev Projects/Mikup/ui"
cargo build 2>&1 | grep -E "^error|Finished"
```

Expected: `Finished` only.

**Step 7: Final commit (if any loose ends)**

```bash
cd "/Users/test/Documents/Dev Projects/Mikup"
git status
```

If clean: done. Otherwise commit remaining changes.
