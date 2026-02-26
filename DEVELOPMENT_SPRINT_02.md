# Development Sprint 02: The Clinical Audio Laboratory

## 1. Objective
Transform Project Mikup from a command-line pipeline into a local-first desktop application with professional-grade audio diagnostics. Move the UI aesthetic to "Minimalist Light / Pastel" and implement a persistent history and a real-time diagnostic suite.

## 2. Core Feature Requirements

### A. The Landing Hub (Ingestion & History)
- **Drop-Zone:** Implement a full-window drag-and-drop overlay for `.wav`, `.mp3`, and `.flac`.
- **Persistent History:** 
    - Store analysis results (JSON payload) in a local `history.json` or SQLite database.
    - Display a "Recent Projects" list with metadata (Filename, Date, Overall Score).
    - Allow users to "Open" an old project without re-processing (Load JSON directly).
- **Storage Management:** Automatically delete processed audio stems (`data/processed/*.wav`) after the analysis JSON is saved to history to preserve disk space.

### B. Live Pipeline Communication
- **Step-by-Step Progress:** Refactor the Tauri-to-Python bridge to use **Events** instead of a single `await`.
- **Frontend Stepper:** Display a vertical progress indicator for:
    1. Surgical Separation (UVR5)
    2. Transcription & Diarization (WhisperX)
    3. Feature Extraction (DSP/LUFS)
    4. AI Synthesis (Gemini 2.0)
- **Status Reporting:** Pulse real-time percentage and current stage text to the UI.

### C. The Integrated LUFS Graph
- **Standardization:** Calculate loudness using the **EBU R128** standard.
- **Visuals:** A high-density multi-line chart (using Recharts or similar) on the X-axis (Time).
- **Y-Axis Streams:**
    - **Master Stream:** Show Integrated (Session Avg), Short-term (3s), and Momentary (400ms) lines.
    - **Stem Streams:** Toggleable lines for Dialogue, Music, and SFX stems.
- **Interaction (Flagging):** 
    - User can click a point on the graph to place a "Flag."
    - Flags act as "Analysis Anchors" that the AI Director uses to explain specific sonic events at that timestamp.

### D. The Diagnostic Meter Bridge
Implement real-time (during playback) and session-average meters:
- **Intelligibility Meter:** A speech-to-noise ratio (SNR) calculation between the Dialogue stem and the Background stems.
- **Correlation Meter:** A phase coherence meter measuring L/R channel relationship (-1 to +1).
- **Stereo Balance:** A needle meter showing the energy distribution between Left and Right.

## 3. Tech Stack & Design Tokens
- **Frontend:** React 19, Tailwind v4, Lucide-Icons, Recharts.
- **Theme:** Minimalist Light (Off-whites, soft pastel blues/lavenders).
- **Color Space:** `oklch()` for perceptually accurate pastel tones.
- **Backend:** Python 3.10+, Tauri v2 (Rust).
- **Audio Specs:** Python must output downsampled time-series data for the graph (1-2 data points per second per stream).

## 4. Architectural Tasks for Codex

### Backend (Python/Rust)
1. Update `src/dsp/processor.py` to calculate Integrated, Short-term, and Momentary LUFS for all 4 stems (Master, Dialogue, Music, SFX).
2. Calculate SNR, Phase Correlation, and Channel Balance averages.
3. Implement a cleanup routine in `src/main.py` that removes WAV files from `data/processed` upon completion of the JSON payload.
4. Integrate Tauri emitting events (`emit("process-status", ...)`).

### Frontend (React/TypeScript)
1. Create `ui/src/components/LandingHub.tsx` with Drag-and-Drop and History.
2. Implement `ui/src/components/DiagnosticMeters.tsx` using SVG or Canvas for smooth needle movement.
3. Refactor `ui/src/components/MetricsPanel.tsx` into a high-density "Integrated Graph" using the new LUFS data.
4. Update `ui/src/App.tsx` to handle the transition between "Landing" and "Analysis" states.

## 5. Definition of Done
- App opens to a clean "Drop Zone" with a history of past scans.
- Dragging a file starts a visible step-by-step progress checklist.
- Result view shows a multi-line LUFS graph that can be flagged.
- Meters (Correlation, Balance, Intelligibility) show real-time feedback during playback.
- Disk usage is minimized by deleting WAV stems after JSON export.
