# Project Mikup: Rust DSP Migration & Feature Expansion Plan

**Date:** February 27, 2026
**Objective:** Migrate the Stage 3 Feature Extraction (DSP) from Python (`src/dsp/processor.py`) to the Tauri Rust backend (`ui/src-tauri/src/`). The goal is to achieve real-time, professional-grade audio metering (iZotope Insight 2 level) at 60 FPS, ensuring memory safety and removing the Python processing bottleneck for UI visualization.

---

## Phase 1: Foundation & Dependencies (Rust Setup)
Before writing DSP math, we must equip the Tauri backend to decode and stream audio efficiently.

1.  **Update `Cargo.toml`:**
    *   Add `symphonia` (or `hound` for simple WAVs) for pure-Rust, fast audio decoding of the separated stems.
    *   Add `cpal` for cross-platform audio playback (if we want the app to actually play the audio while metering) or just buffer management.
    *   Add `ebur128` (optional, but highly recommended over writing K-weighting from scratch) for broadcast-standard LUFS calculation.
    *   Add `rustfft` for frequency analysis (crucial for Masking and Spectral Centroid).
2.  **Scaffold the Rust Module:**
    *   Create `ui/src-tauri/src/dsp/mod.rs` to encapsulate all audio analysis logic.
    *   Create sub-modules for specific metrics: `loudness.rs`, `spatial.rs`, `spectral.rs`.

---

## Phase 2: Core Metric Implementation (The "Math" Layer)
This phase replaces Python's `librosa` and `pyloudnorm` with high-performance Rust equivalents.

1.  **Loudness & Dynamics (`loudness.rs`):**
    *   **LUFS (Integrated, Short-term 3s, Momentary 400ms):** Implement using the `ebur128` crate or manual K-weighting. Must process the `dialogue_raw` and `background_raw` stems.
    *   **True Peak (dBTP):** Implement 4x oversampling on the digital signal to detect analog clipping thresholds.
    *   **LRA (Loudness Range):** Calculate the statistical variance of the Short-term LUFS over the entire file (ignoring the top 5% and bottom 10%).
    *   **Crest Factor:** Calculate the Peak-to-RMS ratio for detecting transient punch (Impact Mikups).
2.  **Spatial Integrity (`spatial.rs`):**
    *   **Phase Correlation (+1 to -1):** Calculate the correlation coefficient between the Left and Right channels of the master or stems.
    *   **Lissajous Vectorscope Coordinates:** Map the L/R amplitude relationship to X/Y coordinates for 2D UI plotting.
3.  **Frequency & Intelligibility (`spectral.rs`):**
    *   **Frequency Masking (Advanced SNR):** Use `rustfft` to compare the frequency spectrum of the `dialogue_raw` stem against the `background_raw` stem. Flag moments where background energy eclipses dialogue energy in the 1kHz–4kHz range.
    *   **Spectral Centroid (Vibe/Aggression):** Calculate the amplitude-weighted mean frequency to determine if a scene is "dark/warm" or "bright/aggressive."

---

## Phase 3: The Streaming Architecture (Tauri IPC)
We cannot wait for the entire file to process before updating the UI. Rust must stream data chunks.

1.  **The Analysis Thread:**
    *   Create a Rust background thread that opens the WAV stems using `symphonia`.
    *   Read the audio in small frames (e.g., 2048 or 4096 samples).
2.  **The Tauri Event Emitter:**
    *   As each frame is processed through Phase 2's math modules, serialize the results into a JSON object (e.g., `DspFrame { momentary_lufs: -14.2, true_peak: -1.1, correlation: 0.8, ... }`).
    *   Use Tauri's `app.emit("dsp-frame", payload)` to blast this data to the frontend at ~60 FPS.
3.  **The Final Payload Assembly:**
    *   When the file finishes, Rust must compile the *Integrated* metrics (Total LUFS, total LRA, overall Pacing Mikups) and write them to `mikup_payload.json` so the AI Director (Stage 5) still receives its required data.

---

## Phase 4: Frontend Visualization (React Updates)
The UI must be updated to catch the high-speed Rust data stream.

1.  **Update `ui/src/types.ts`:**
    *   Define the new `DspFrame` interface to match the Rust payload.
    *   Update `MikupPayload` to include the new metrics (LRA, True Peak, Masking Flags).
2.  **Real-Time `DiagnosticMeters.tsx`:**
    *   Refactor to listen to the `tauri://dsp-frame` event.
    *   Animate the StatsBars smoothly based on the incoming stream (using requestAnimationFrame or React state, being careful not to overwhelm the render cycle).
3.  **New Visualizers:**
    *   Build a `LissajousScope.tsx` component that draws the X/Y coordinates onto an HTML5 `<canvas>` for spatial monitoring.
    *   Update `MetricsPanel.tsx` (Recharts) to plot the newly acquired LRA and True Peak history over time.

---

## Execution Order
1.  Add crates to `Cargo.toml`.
2.  Build a simple `symphonia` WAV reader in `dsp/mod.rs` to prove we can parse the stems.
3.  Implement basic Momentary LUFS and True Peak in Rust.
4.  Wire up the `app.emit` Tauri stream to the React frontend and verify the meters move.
5.  Flesh out the advanced math (Masking, Lissajous, LRA).
6.  Remove `src/dsp/processor.py` entirely.
