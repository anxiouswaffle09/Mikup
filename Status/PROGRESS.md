# Project Mikup Progress Tracker

## Current Status: Phase 4 (Interactive DAW & Performance Tuning) 🧩
**Status:** Refining Real-time DAW experience and Native Vizia UI.
The 3-stem hybrid pipeline and core Vizia shell are fully integrated. Now focusing on high-performance playback and scrubbing.

### ✅ Completed
- [x] **Platform Stabilization:** Fixed path resolution (`#13`), transient storage (`#2`), and logging standards (`#17`) for Windows/macOS compatibility.
- [x] **WSL2 Environment:** Installed Mesa (OpenGL/Vulkan) and PulseAudio/ALSA dependencies for native Vizia UI and audio engine support.
- [x] **SPEC.md Update:** Defined the 3-stem canonical naming (`DX`, `Music`, `Effects`).
- [x] **Python Refactor:** `separator.py` and `main.py` updated to use the new hybrid 2-pass architecture.
- [x] **Frontend Pivot:** Successfully migrated from Tauri/React to native **Vizia** UI for high-performance telemetry.
- [x] **Project-First Workspace:** Automated generation of `Projects/<NAME>_<TIMESTAMP>/`.
- [x] **Real-time Vectorscope:** Integrated Rust spatial metrics into the Vizia UI.
- [x] **3-Channel Live Meters:** Upgraded `loudness.rs` to independent DX/Music/Effects LUFS meters in the UI.
- [x] **Native Windows Support:** Added `requirements-windows.txt` and DirectML acceleration for non-NVIDIA native hardware.
- [x] **Versioned Iteration:** Implemented `--redo-stage` logic in Python and added "Redo Stage" UI controls in Vizia.
- [x] **Storage Awareness:** Integrated native disk space reporting (`get_available_disk_space`) and Storage Gauge UI.
- [x] **Code Review Audit (March 5, 2026):** Resolved 28 identified stability and performance issues across the Python and Rust codebase. (See `Status/RESOLVED_FIXES_2026_03_05.md`).
- [x] **Optimized Rust-side seeking:** Improving DAW-level playhead scrubbing for ultra-low latency navigation.
- [x] **Telemetry & Waveform Cache:** Developed a binary cache for the master reference waveform and LUFS time-series data for instant load times.
- [x] **Forensic Canvas UI Redesign:** Vizia UI updated to 2-Column Forensic Canvas, integrating Unified LUFS Graph and markers.
- [x] **Scrubbing Ergonomics:** Added "Seek Sensitivity" and synchronized the playhead/scrubbing across the entire Forensic Canvas.
- [x] **Master-First Telemetry:** Consolidated real-time LUFS and dynamics meters to reflect the Master mix only, keeping stem data on the historical graph.
- [x] **Python Cleanup:** Removed the stale `src/dsp` directory to clarify the Rust/Python boundary.
- [x] **Audio Standards & Targets:** Implemented the `AudioTargets` model and persistent `AppConfig` in Rust for user-selected standards (Cinema, Streaming, etc.).
- [x] **Data Center UI Redesign:** Restructured Column 2 with split Static/Live analytics and a tabbed Forensic Radar (Mix, Pace, Tex).

### 🚧 In Progress
- [ ] **Tonal Balance Analyzer:** Developing the floating spectral analysis window with statistical target zones (TBC style).
- [ ] **Async DAW Core:** Refactoring `AudioController` for Master-First playback and hot-loading stems.
- [ ] **Global Menu & Settings:** Implementing the Vizia Menu Bar and the Audio Settings Modal (Hardware/Rate).
- [ ] **Metric Wiring:** Plumbing scalar metrics (Integrated LUFS, Max True Peak, Phase) into the WorkspaceAssets and UI.

## Decision Vault 🏛️
| Date | Decision | Rationale |
| :--- | :--- | :--- |
| 2026-03-08 | **Asynchronous DAW Environment** | Transition from blocking "Processing" view to DAW-first environment. Enter Workspace instantly with Master-only telemetry while AI separation runs in the background. |
| 2026-03-08 | **Master-First Playback** | Use original Master file for default playback (bit-perfect) to avoid stem-mixing artifacts; switch to stems only on Solo/Mute. |
| 2026-03-07 | **STOI Deprecation** | Formally deprecated STOI and Python-based forensics in favor of real-time Rust-based SNR masking and Tonal Balance telemetry. |
| 2026-03-07 | **Insight 2 / TBC UI Pivot** | Incorporate industry-standard metering paradigms (split Integrated/Momentary metrics and statistical tonal zones) into the native Vizia UI. |
| 2026-03-07 | **Floating Forensic Modules** | Use root `ZStack` overlays for secondary analysis windows (Tonal Balance) to bypass OS-level multi-window GPU constraints while maintaining 60fps sync. |
| 2026-03-06 | **Master-First Telemetry** | Reduce UI clutter and CPU overhead in the DSP thread; provide a focused "Cockpit" experience for the final output while relying on the graph for surgical stem forensics. |
| 2026-03-05 | **Postpone AI Director** | The floating AI Director chat interface is deprioritized for much later to focus on core UI, data accuracy, and ergonomics. |

## Next Steps 🚀
1.  **[Claude/Opus]** Build the Floating Tonal Balance overlay and the custom spectral canvas.
2.  **[Claude/Codex]** Finalize the Rust background scanner for Master-only Pass 1.
3.  **[Claude/Sonnet]** Wire scalar metrics (INT LUFS, PEAK) from the scanner into the Data Center UI.
