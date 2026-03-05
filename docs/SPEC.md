# Mikup Technical Specification (Source of Truth)

**Version:** 0.3.0-beta
**Focus:** Hybrid Surgical Separation (MBR + CDX23)
**Platforms:** Windows (10/11), macOS (Silicon/Intel)

## 1. Surgical Separation Pipeline (Stage 1)
All separation follows this hybrid 2-pass architecture.

### Pass 1: MBR Vocal Extraction
- **Model:** `vocals_mel_band_roformer.ckpt` (SDR 12.6) via audio-separator
- **Stems:** `vocals` → DX candidate, `other` → instrumental
- **Rationale:** Specialist vocal model outperforms CDX23's single-pass 3-way split for dialog clarity.

### Pass 2: CDX23 Instrumental Split
- **Model:** CDX23 (Demucs4/DnR) via demucs API
- **Input:** `other` (instrumental) from Pass 1
- **Stems:** `Music`, `Effects` (CDX23's own dialog output is discarded)
- **Models dir:** `~/.cache/mikup/cdx23/` (auto-downloaded on first run)
- **Rationale:** With dialog already removed, CDX23 cleanly splits music vs. effects.

### Pass 2b: DX Refinement (optional)
- **Model:** `BS-Roformer-Viperx-1297` (`model_bs_roformer_ep_317_sdr_12.9755.ckpt`)
- **Action:** Process the Pass 1 vocals stem.
- **Outputs:** `DX` (clean dialogue), `DX_Residual` (residual bleed).
- **Toggle:** Skipped when `fast_mode=True`.

## 2. Canonical Stem Naming
The project officially deprecates the 5-stem "Cinematic Trinity" split in favor of a high-fidelity 3-stem hybrid:
- `DX`: Primary dry dialogue.
- `Music`: Full orchestral/electronic score.
- `Effects`: All non-music, non-dialog audio (hard FX, ambience, foley combined).
- `DX_Residual`: Optional residual from Pass 2b; omitted in fast mode.

## 3. Platform Standards
### macOS (Darwin)
- **Dependencies:** `pip install -r requirements-mac.txt`
- **Torch:** Use `mps` device (Metal Performance Shaders).
- **ONNX:** Use `CoreMLExecutionProvider`.
- **FFmpeg:** Must be available via `brew`.

### Windows (NT)
- **Dependencies:** `pip install -r requirements-windows.txt`
- **Torch:** Use `cuda` (NVIDIA) or `directml` (AMD/Intel/Generic) via `torch-directml`.
- **ONNX:** Use `DmlExecutionProvider` or `CUDAExecutionProvider`.
- **FFmpeg:** Must be in system PATH (e.g., via `scoop` or manual install).
- **UI:** Native Vizia 0.3.0 binary (DirectX/Skia).

### Runtime Environment (WSL2 Hybrid)
- **Agent Context:** All implementation agents (Gemini, Claude, Codex) and the Python processing pipeline run within **WSL2 (Ubuntu)**.
- **Cross-OS Access:** The codebase resides on the Windows host (`/mnt/d/SoftwareDev/Mikup`), allowing agents to modify files that the Windows-native Vizia UI then consumes.
- **Execution:** While processing happens in WSL2, hardware-accelerated tasks (DirectML/CUDA) are passed through to the Windows GPU drivers.

## 4. Engineering Standards

### 4.1 Path Normalization
- **Strict Pathlib:** All file system interactions must use `pathlib.Path`.
- **Resolution:** Paths must be anchored to `PROJECT_ROOT` to ensure consistency across Windows (`\`) and macOS (`/`).
- **No Relative Defaults:** Functions must not use relative string literals (e.g., `"data/config.json"`) for machine-level state.

### 4.2 Transient Storage
- **Platform-Agnostic Temp:** Intermediate artifacts (stems before workspace movement) must use `tempfile.gettempdir()`.
- **Cleanup:** Temporary directories must be purged upon successful workspace migration to prevent storage bloat.

## 5. UI/UX Standards
- **Mikup Console:** A real-time, autoscrolling terminal log in the "Processing" view.
- **Visuals:** Minimalist Light / Pastel (`oklch()`).
- **Telemetry:** 120fps live metering (LUFS, Phase, Vectorscope) via Vizia Model/Lens architecture.

## 6. Workspace Layout

Every pipeline run produces a self-contained project directory.

### Auto-Generated Workspace (default)
When `--output-dir` is not passed, `main.py` reads `default_projects_dir` from
`data/config.json` (fallback: `<repo_root>/Projects/`) and generates:

```
Projects/
  <input_stem>_<YYYYMMDD_HHMMSS>/
    stems/           ← raw separator WAV outputs
    data/
      stage_state.json
      stems.json
      transcription.json
      dsp_metrics.json
      semantics.json
      .mikup_context.md
    mikup_payload.json
    mikup_report.md     ← written only if AI Director runs
```

### Global State (`data/`)
`data/` is reserved for machine-level state only:
- `data/history.json` — ordered index of all processed projects (last 50).
- `data/config.json` — settings: `default_projects_dir`, future preferences.

`data/processed/`, `data/raw/`, `data/output/` are legacy paths; do not create
new artifacts there.

## 7. Versioned Iteration & Invalidation Protocol

To support non-destructive iteration and error correction, Mikup implements a "Redo" mechanism with strict downstream invalidation rules.

### 7.1 Dependency Waterfall
The pipeline is a linear dependency chain. Redoing any stage automatically invalidates all subsequent stages:
1. **Separation** (Root)
2. **Transcription** (Depends on DX stem)
3. **Semantics** (Depends on Background stems)
4. **AI Director** (Depends on All Metadata)

### 7.2 Invalidation Rules
- **Destructive Overwrite:** To save disk space, a "Redo" operation overwrites existing artifacts for that stage. Branching (v1, v2) is currently not supported to prevent storage bloat.
- **Model Locking:** Once a project is initialized, it is "locked" to the models and parameters defined at creation. Rerunning a stage uses these locked settings to ensure deterministic results.
- **Downstream Purge:** When `--redo-stage <STAGE>` is invoked, the system:
    1. Deletes artifacts for `<STAGE>`.
    2. Deletes artifacts for all stages appearing later in the Waterfall.
    3. Resets `stage_state.json` for those stages.

### 7.3 Storage Awareness
The UI must provide a real-time **Storage Gauge** (available vs. used) to prevent pipeline failures during heavy separation tasks.
