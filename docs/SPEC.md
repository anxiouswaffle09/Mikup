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

## 8. AI Director & Multimodal Chat
Mikup acts as a read-only research tool. The AI Director does not modify audio. Instead, it utilizes **On-Demand Audio Slicing**. The Rust frontend passes timeline coordinates to the Python backend, which slices the raw WAV files and sends the audio bytes to the multimodal LLM (Gemini 2.0), allowing the AI to "listen" and analyze specific anomalies.

**Interactive REPL Protocol:**
The bi-directional chat uses a persistent stdin/stdout pipe.
- **Input (Rust -> Python):** `{"text": "...", "playhead_time": 125.4, "audio_context": {"start_time": 80.0, "end_time": 85.0, "stem": "Effects"}}`
- **Output (Python -> Rust):** `{"type": "response", "text": "..."}`

**Context-Aware Standards:**
- **Always-On Context:** Every message sent from Rust to Python MUST include the current `playhead_time` (in seconds) to ensure the AI always knows where the user is looking.
- **User Override:** If a user manually specifies a timestamp in their text (e.g., "Check the noise at 01:20"), the AI should prioritize the text-based timestamp over the silent `playhead_time` context.
- **Timestamp Interaction:** Clicking a `[MM:SS:ms]` timestamp in the chat UI will **move the playhead only**. No auto-looping or soloing is performed.

**Graceful Cancellation Protocol:**
To prevent VRAM corruption or stranded processes during heavy ML tasks (Separation/Transcription):
- **Signal Handling:** The Python backend implements a `SIGTERM` handler.
- **Rust Command:** When the user clicks "Cancel," Rust sends a `SIGTERM` to the child process.
- **Python Response:** The backend catches the signal, flushes all pending JSON logs, deletes any partial transient artifacts, and exits with a `130` code.

## 9. UI-First Forensic Dashboards
Project Mikup is a visual-first forensic application. The UI is architected as a **2-Column Forensic Suite** (70/30 split) using Vizia's `HStack`. For a detailed visual blueprint, refer to [docs/UI_LAYOUT.md](UI_LAYOUT.md).

### 9.1 Column 1: The Forensic Canvas (Left - 70%)
The primary research area for visualizing time-based data.
- **Reference Waveform:** Top-most track showing the original file waveform (Visual Truth).
- **Unified Forensic Graph:** Middle track showing high-resolution curves on a **fixed -60 to 0 LUFS scale**:
    - **Yellow (Solid):** `DX` Integrated LUFS.
    - **Purple (Solid):** `Music` Integrated LUFS.
    - **Cyan (Solid):** `Effects` Integrated LUFS.
    - **White (Solid):** `Master` Integrated LUFS.
    - **White (Dashed):** `Pacing Density` (Syllables per second).
- **Forensic Markers (Anomalies):** Discrete icons pinned to the graph at exact timestamps:
    - **Masking Alert ( ! ):** STOI or Spectral SNR drops below thresholds.
    - **Impact Peak ( ⚡ ):** Sudden transients in Effects/Music.
    - **Ducking Signature ( ⬇️ ):** Mathematical detection of deliberate gain reduction.
    - **Pacing Milestone ( 🏁 ):** Acceleration or deceleration points (>30% shift).
- **Main Stage (Footer):** Semantic tags (e.g., `[TRAFFIC]`, `[RAIN]`) and the system log terminal.

### 9.2 Column 2: The Data Center (Right - 30%)
The research deep-dive area, starting parallel to the Reference Waveform.
- **Global Vitals (Persistent Top):** High-density meters for Master LUFS, Clarity (STOI), and Energy (Speech Rate).
- **Forensic Radar (Tabbed Research):** A tabbed workstations area:
    - **[ MIX ]:** Full Dynamics/LRA dials for all stems.
    - **[ PACE ]:** nPVI Rhythm Index, Articulation Rate, and Silence Ratio dials.
    - **[ TEX ]:** Spectral Centroid, Stereo Width, and Texture markers.

### 9.3 The Floating AI Director
- **Visualization:** A floating overlay bubble ( (AI) ) in the bottom-right corner, implemented via Vizia `ZStack`.
- **Behavior:** Clicking the bubble expands a non-intrusive chat window over the Forensic Radar.
- **Alert Integration:** The AI automatically summarizes the forensic markers from Section 9.1 in its initial report.
