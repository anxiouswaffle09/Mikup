# Project Mikup: Interactive DAW Migration Plan (Tauri + Rust + React)

**Date:** February 27, 2026
**Objective:** Transform the "Analysis Result" page from a static report into an interactive, DAW-like diagnostic environment. This involves a native Rust audio engine for perfect synchronization, pre-calculated offline metrics for global graphs, and a real-time playback-linked DSP stream.

---

## Phase A: The Offline Payload Upgrade (Pre-Calculated Data)
To draw the global LUFS graph and place markers on the timeline *instantly*, we need data before playback starts.

1.  **Rust DSP Stage (Stage 3) Update:**
    *   **Downsampled LUFS Series:** As Rust analyzes the file (faster than real-time), it must generate an array of Momentary LUFS values (e.g., 2 samples per second).
    *   **Diagnostic Event Detection:** Rust will scan for "Events" such as:
        *   `LOW_INTELLIGIBILITY`: SNR < 10dB.
        *   `PHASE_ISSUE`: Correlation < 0.0 for > 500ms.
        *   `PEAK_CLIPPING`: True Peak > -0.1 dBTP.
        *   `SPEECH_MASKED`: Background frequency energy > Dialogue energy in 1-4kHz.
2.  **Payload Schema Update:** Save these arrays and event objects to `mikup_payload.json` so the UI can draw the "Global Map" of the episode immediately upon loading.

---

## Phase B: Native Rust Audio Playback Engine (`cpal`)
To solve the playback sync problem, Rust must become the master of the audio clock.

1.  **Audio Output Thread:**
    *   Implement an audio output loop using the `cpal` crate.
    *   Rust will read the `dialogue_raw` and `background_raw` stems, mix them (or handle solo/mute), and push them to the OS sound card.
2.  **The Master Clock:**
    *   Rust tracks the exact sample index being sent to the speakers. This is the "True Time."
    *   Every time Rust pushes a buffer to the speakers, it runs the `Loudness`, `Spatial`, and `Spectral` analyzers on *that exact buffer* and emits the `dsp-frame` event to React.

---

## Phase C: The Playback Sync Manager (Tauri Commands)
Create the "Remote Control" for the native engine.

1.  **Command: `play_audio(start_time_secs)`:** Tells Rust to seek the decoders to a timestamp and start the `cpal` output loop.
2.  **Command: `pause_audio()`:** Stops the `cpal` output loop and the DSP stream.
3.  **Command: `seek_audio(time_secs)`:** Instantly jumps the Rust decoders and emits a single DSP frame for that position so the UI updates while scrubbing.
4.  **Command: `set_stem_volumes(dialogue_vol, background_vol)`:** Allows real-time mixing (e.g., soloing dialogue to hear the "masking" issues).

---

## Phase D: Interactive Analysis UI (React)
Update the frontend to be a high-performance dashboard driven by the Rust clock.

1.  **`WaveformVisualizer` Sync:**
    *   Instead of `wavesurfer.js` playing the audio, it will act as a "Scrubber." 
    *   When the user clicks the waveform, React calls `seek_audio` in Rust.
    *   React listens for a `playback-progress` event from Rust to move the visual playhead.
2.  **Interactive Transcript (`TranscriptScrubber.tsx`):**
    *   Render the word-level segments from the payload.
    *   Highlight words in real-time based on the Rust playback clock.
    *   Clicking a word calls `play_audio(word.start_time)`.
3.  **Live Dashboard Integration:**
    *   `LiveMeters` and `Vectorscope` will now "dance" in perfect sync with the audio you hear on the Analysis page.
    *   `MetricsPanel` will draw the static LUFS graph using the pre-calculated data from Phase A.

---

## Execution Order
1.  **[Codex]** Implement `seek` in `MikupAudioDecoder` and the pre-calculated LUFS/Event logic for Phase A.
2.  **[Codex]** Setup the basic `cpal` playback loop in Rust (Phase B).
3.  **[Claude]** Build the `TranscriptScrubber` and wire the `WaveformVisualizer` to the Rust play/seek commands (Phase C & D).
4.  **[Claude]** Integrate the Live Dashboard into the Analysis view.
