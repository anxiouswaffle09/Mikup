# Project Mikup Progress Tracker

## Current Status: Phase 4 (Interactive DAW & Performance Tuning) 🧩
**Status:** Refining Real-time DAW experience and Native Vizia UI.
The 3-stem hybrid pipeline and core Vizia shell are fully integrated. Now focusing on high-performance playback and scrubbing.

### ✅ Completed
- [x] **Platform Stabilization:** Fixed path resolution (`#13`), transient storage (`#2`), and logging standards (`#17`) for Windows/macOS compatibility.
- [x] **WSL2 Environment:** Installed Mesa (OpenGL/Vulkan) and PulseAudio/ALSA dependencies for native Vizia UI and audio engine support.
- [x] **SPEC.md Update:** Defined the 3-stem canonical naming (`DX`, `Music`, `Effects`).
- [x] **Python Refactor:** `separator.py` and `main.py` updated to use the new hybrid 2-pass architecture.
- [x] **Frontend Pivot:** Successfully migrated from Tauri/React to native **Vizia** UI for 120fps telemetry.
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

### 🚧 In Progress
- [ ] **Scrubbing Ergonomics:** Adding a "Seek Sensitivity" toggle in the Vizia settings for smoother high-zoom scrubbing.

## Decision Vault 🏛️
| Date | Decision | Rationale |
| :--- | :--- | :--- |
| 2026-03-05 | **Postpone AI Director** | The floating AI Director chat interface is deprioritized for much later to focus on core UI, data accuracy, and ergonomics. |
| 2026-03-02 | **Versioned Iteration (Redo)** | Allow users to redo stages (e.g., Separation) with downstream invalidation to fix errors. |
| 2026-03-01 | **3-Stem Hybrid Pivot** | CDX23's dialog separation is inferior to MBR; hybridizing MBR for Vocals + CDX23 for Instrumental provides superior clarity. |
| 2026-03-03 | **Mikup Native (Vizia)** | Pivot from Tauri/React to native Vizia UI for 120fps telemetry and zero-IPC overhead. |
| 2026-02-28 | **Interactive DAW Pivot** | Moving away from static reports to a real-time diagnostic workspace via Vizia. |

## Next Steps 🚀
1.  **[Claude/Codex]** Refine DSP metrics: Ensure Vocal Texture applies only to DX, Transient events to FX/MX, and Intelligibility uses Master/Stems.
2.  **[Claude]** Add "Seek Sensitivity" toggle in Vizia settings for smoother high-zoom scrubbing.
