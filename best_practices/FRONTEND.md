# Best Practices: Vizia (Native Rust UI)

Updated as of: March 5, 2026

## Core Philosophy
Mikup uses **Vizia 0.3.0** for the frontend to ensure 120fps telemetry and zero-IPC overhead. Vizia is a retained-mode, reactive GUI framework powered by Skia.

### Key Practices:
- **Model/Lens Pattern:** Strictly follow the Model/Lens architecture defined in `best_practices/reference/vizia.md`.
- **Wait-Free UI:** Never block the main thread. Use `cx.spawn()` for async tasks and `ContextProxy` for cross-thread updates.
- **Pointer-Based Diffing:** Use `Arc` and `Arc::ptr_eq` for complex data structures to ensure $O(1)$ change detection.
- **Custom Drawing:** Use the `Canvas` API for high-frequency visualizations (Waveforms, Unified Forensic Graph).

## Forensic Dashboard Architecture
Project Mikup is a visual-first forensic application. The UI is architected with a **Z-ordered 2-Column Suite**.

### 1. The Root ZStack (Layers)
- **Base Layer:** The primary 2-column `HStack`.
- **Top Layer:** The `AIDirectorBubble`. Absolute positioned `BottomRight`. 

### 2. The Forensic Canvas (Left - 70% Width)
- **HStack Child 1:** `Stretch(0.7)`.
- **Top:** `ReferenceWaveform` (Original WAV).
- **Middle:** `UnifiedForensicGraph` (Combined LUFS + Pacing).
- **Z-Order (Graph):** Solid color LUFS paths (Background), Dashed Pacing Path (Middle), Forensic Icons (Foreground).
- **Footer:** `MainStage` (Semantic Tags) and `SystemLog` terminal.

### 3. The Data Center (Right - 30% Width)
- **HStack Child 2:** `Stretch(0.3)`.
- **Global Vitals (Top):** Fixed-height high-density meters.
- **Forensic Radar (Bottom):** Tabbed interface (`TabContainer`) for `MixWorkstation`, `PacingWorkstation`, and `TextureWorkstation`.

## Handoff-First Mandate (Windows)
Since agents run in WSL2, we cannot run the Vizia GUI. 

### Mandatory Procedure:
1. **Implement in Rust:** Write the View/Model logic in `native/src/`.
2. **Compile Check (WSL2):** Run `cargo check --manifest-path native/Cargo.toml`.
3. **Handoff for Windows:** Provide the `cargo run` command for verification on the host.

## Diagnostic Visualization
- **Performance:** Use `draw()` overrides for real-time DSP rendering.
- **Telemetry:** Data flows from `audio_engine.rs` to the UI via `rtrb` (lock-free ring buffers).
- **Batching:** Aggregate audio metrics and emit UI updates every 8-16ms.
