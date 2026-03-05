# Project Mikup Progress Tracker

## Current Status: Phase 4 (Interactive DAW & Versioned Iteration) 🧩
**Status:** Implementing Non-Destructive Redo & Storage Awareness.
The core 3-stem hybrid pipeline is functional. Now focusing on the "Pro" experience: re-running stages and managing project storage.

### ✅ Completed
- [x] **Platform Stabilization:** Fixed path resolution (`#13`), transient storage (`#2`), and logging standards (`#17`) for Windows/macOS compatibility.
- [x] **SPEC.md Update:** Defined the 3-stem canonical naming (`DX`, `Music`, `Effects`).
- [x] **Python Refactor:** `separator.py` and `main.py` updated to use the new hybrid 2-pass architecture.
- [x] **Frontend Types:** `ui/src/types.ts` updated to recognize the 3-stem outputs.
- [x] **Rust DSP Sync:** Updated `ui/src-tauri/src/dsp/mod.rs` and `scanner.rs` to 3 stems.
- [x] **UI Component Refresh:** Updated `StemControlStrip.tsx` and `MetricsPanel.tsx` for the 3-stem model.
- [x] **Project-First Workspace:** Automated generation of `Projects/<NAME>_<TIMESTAMP>/`.
- [x] **Real-time Vectorscope:** Integrated Rust spatial metrics into the React UI.
- [x] **3-Channel Live Meters:** Upgraded `loudness.rs` and `DiagnosticMeters.tsx` to independent DX/Music/Effects LUFS.
- [x] **Native Windows Support:** Added `requirements-windows.txt` and DirectML acceleration for non-NVIDIA native hardware.

### 🚧 In Progress
- [ ] **Versioned Iteration:** Support for "Redoing" stages with downstream invalidation.
- [ ] **Storage Awareness:** Disk space gauge and safety checks in the UI.
- [ ] **Optimized Rust-side seeking:** Improving DAW-level playhead scrubbing.

## Decision Vault 🏛️
| Date | Decision | Rationale |
| :--- | :--- | :--- |
| 2026-03-02 | **Versioned Iteration (Redo)** | Allow users to redo stages (e.g., Separation) with downstream invalidation to fix errors. |
| 2026-03-01 | **3-Stem Hybrid Pivot** | CDX23's dialog separation is inferior to MBR; hybridizing MBR for Vocals + CDX23 for Instrumental provides superior clarity. |
| 2026-03-03 | **Mikup Native (Vizia)** | Pivot from Tauri/React to native Vizia UI for 120fps telemetry and zero-IPC overhead. |
| 2026-02-28 | **Interactive DAW Pivot** | Moving away from static reports to a real-time diagnostic workspace via Vizia. |

## Next Steps 🚀
1.  **[Codex]** Update `src/main.py` with `--redo-stage` logic and destructive overwrite.
2.  **[Claude]** Implement `get_disk_space` in Vizia/Rust and the Storage Gauge UI component.
3.  **[Claude]** Add "Redo Stage" buttons to the Project/LandingHub view in Vizia.
