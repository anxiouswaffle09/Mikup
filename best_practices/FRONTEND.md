# Best Practices: Vizia (Native Rust UI)

Updated as of: March 4, 2026

## Core Philosophy
Mikup uses **Vizia 0.3.0** for the frontend to ensure 120fps telemetry and zero-IPC overhead. Vizia is a retained-mode, reactive GUI framework powered by Skia.

### Key Practices:
- **Model/Lens Pattern:** Strictly follow the Model/Lens architecture defined in `best_practices/reference/vizia.md`.
- **Wait-Free UI:** Never block the main thread. Use `cx.spawn()` for async tasks and `ContextProxy` for cross-thread updates.
- **Pointer-Based Diffing:** Use `Arc` and `Arc::ptr_eq` for complex data structures to ensure $O(1)$ change detection.
- **Custom Drawing:** Use the `Canvas` API for high-frequency visualizations (Waveforms, Vectorscopes).

## Handoff-First Mandate (Windows)
Since agents (Gemini, Claude, Codex) run in WSL2, we cannot run the Vizia GUI. 

### Mandatory Procedure for All UI Tasks:
1. **Implement in Rust:** Write the View/Model logic in `native/src/`.
2. **Compile Check (WSL2):** Run `cargo check --manifest-path native/Cargo.toml` to ensure no syntax errors.
3. **Handoff for Windows:** Provide the user with the following command to verify the UI:
   ```powershell
   # Run from Windows Terminal (PowerShell)
   cd native
   cargo run --bin mikup-native
   ```

## Diagnostic Visualization
- **Performance:** Use `draw()` overrides for real-time DSP rendering.
- **Telemetry:** Data flows from `audio_engine.rs` to the UI via `rtrb` (lock-free ring buffers).
- **Batching:** Aggregate audio metrics and emit UI updates every 8-16ms to balance responsiveness and CPU load.
