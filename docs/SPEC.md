# Mikup Technical Specification (Source of Truth)

**Version:** 0.3.6-beta
**Focus:** Forensic Baselines & Theatrical Translation
**Platforms:** Windows (10/11), macOS (Silicon/Intel)

## 1. Asynchronous DAW Environment (Core Architecture)
Mikup operates as a non-blocking, DAW-first environment. Unlike traditional "process-then-view" tools, Mikup enters the Workspace immediately upon project creation.

### 1.1 Master-First Handoff
- **Pass 1 (Rust - Instant):** Upon project creation, the Rust `scanner.rs` performs a 100x+ real-time scan of the original **Master File**.
  - **Result:** LUFS, True Peak, and Global Transient Density (Sound Design Pacing) are available within <2 seconds. The DAW becomes functional immediately.
- **Pass 2 (Python - Background):** The ML pipeline (Separation/Transcription) runs asynchronously in the background.
  - **Result:** Stems and Transcript data are "hot-loaded" into the active Workspace as they become available. The UI enriches from "Master-only" to "Full Forensic" state.

### 1.2 Pipeline Control Modes
- **Autonomous Mode:** The pipeline runs from Stage 1 to Stage 3 without interruption.
- **Step-by-Step Mode:** The pipeline pauses after each major stage (Separation, Transcription) and requires user confirmation via the UI to proceed.
- **Live Switching:** Users can toggle between these modes at any time via the Status Bar.

## 2. Surgical Separation Pipeline
All separation follows this hybrid async architecture.
- **Pass 1: MBR Vocal Extraction** - Isolate dialogue from background.
- **Pass 2: CDX23 Instrumental Split** - Split background into Music and Effects.
- **Pass 2b: DX Refinement (optional)** - Skipped when `fast_mode=True`.

## 3. Canonical Stem Naming
The project officially uses a high-fidelity 3-stem hybrid:
- `DX`: Primary dry dialogue.
- `Music`: Full orchestral/electronic score.
- `Effects`: All non-music, non-dialog audio (hard FX, ambience, foley combined).
- `MASTER`: Original Source File (Bit-perfect reference).

## 4. Platform Standards
Mikup is a native WSL2/Linux application with high-performance Rust core.

## 5. Engineering Standards
- **Telemetry:** 60fps live metering (LUFS, Phase, Vectorscope) via Vizia Model/Lens architecture.
- **Unified Scrubbing:** All canvases (Waveforms + Graphs) are synchronized to the global playhead.
- **Master-First Playback:** By default, the engine plays the original **Master File** (Bit-perfect). Stem mixing is only utilized when a stem is Soloed or Muted.

## 6. UI/UX Standards
- **Global Menu Bar:** Integrated `File`, `View`, `Settings (Audio)`, and `Help`.
- **New Project Wizard:** A step-by-step setup for project configuration (Name, File, Fast Mode, Flow Preference).
- **Status Bar:** Persistent bottom bar showing pipeline progress and the Mode Toggle (Auto vs. Manual).
- **Skeleton Loaders:** Metrics display pulsing `[ ANALYZING... ]` states during initial file scans.

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
      .mikup_cache   ← binary telemetry cache (Rust generated)
    mikup_payload.json
    mikup_report.md     ← written only if AI Director runs
```

### Global State (`data/`)
`data/` is reserved for machine-level state only:
- `data/history.json` — ordered index of all processed projects (last 50).
- `data/config.json` — settings: `default_projects_dir`, future preferences.

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

## 9. UI-First Forensic Dashboards
Project Mikup is a visual-first forensic application. The UI is architected as a **2-Column Forensic Suite** (70/30 split) using Vizia's `HStack`. For a detailed visual blueprint, refer to [docs/UI_LAYOUT.md](UI_LAYOUT.md).

### 9.1 Column 1: The Forensic Canvas (Left - 70%)
The primary research area for visualizing time-based data.
- **Reference Waveform:** Top-most track showing the original file waveform (Visual Truth). Interactive for scrubbing.
- **Unified Forensic Graph:** Middle track showing high-resolution curves on a **fixed -60 to 0 LUFS scale**. These curves are pre-calculated by the **Rust Offline Scanner** at 10Hz and read from the binary cache:
    - **Yellow (Solid):** `DX` Integrated LUFS.
    - **Purple (Solid):** `Music` Integrated LUFS.
    - **Cyan (Solid):** `Effects` Integrated LUFS.
    - **White (Solid):** `Master` Integrated LUFS.
    - **White (Dashed):** `Pacing Density` (Syllables per second).
- **Forensic Markers (Anomalies):** Discrete icons pinned to the graph at exact timestamps.
- **Main Stage (Footer):** Semantic tags (e.g., `[TRAFFIC]`, `[RAIN]`) and the system log terminal.

### 9.2 Column 2: The Data Center (Right - 30%)
The research cockpit for the **Master Mix** in real-time.
- **Audio Standards & Targets (Top Config):** Dropdown for **Standard Preset** (Cinema, Streaming, Broadcast, Web, Custom). Updates targets for LUFS, dBTP, and Phase Correlation.
- **Master Vitals (Split Display):**
    - **Static Analysis (Initial Scan):** Integrated LUFS, Max True Peak, Overall Phase Correlation, and SNR (if available). Computed file-wide during the initial scan; violations turn **RED**.
    - **Live Vitals (Real-time):** Momentary LUFS, Live Peak, and Live Phase meters tracking the current playhead.
- **Forensic Radar (Tabbed Research):** 
    - **[ MIX ]:** Vectorscope (Master Phase/Width), LRA, and Crest Factor. Features a **Fader 5 Safety Check** to simulate real-world theater playback.
    - **[ PACE ]:** Pacing Density (derived from Transcription) and Speech Rate.
    - **[ TEX ]:** **Vocal Texture** (Spectral Entropy) - *Note: This remains mapped specifically to the DX stem for diagnostic clarity.*

### 9.3 Floating Forensic Modules
- **The Floating AI Director:** A floating overlay bubble ( (AI) ) in the bottom-right corner, implemented via Vizia `ZStack`.
- **Tonal Balance Analyzer (Floating Window):** A high-fidelity analyzer modeled after iZotope Tonal Balance Control.
    - **Spectral Distribution:** 4-band analysis (Low, Low-Mid, High-Mid, High) with blue **Target Zones** (statistical norms) and a real-time FFT indicator line.
    - **Low-End Crest Factor:** Dedicated "Punch vs. Sustain" meter for low-frequency dynamics.
    - **Internal Overlay:** Implemented via root `ZStack` and absolute positioning; behaves like a draggable plugin window within the main application.
