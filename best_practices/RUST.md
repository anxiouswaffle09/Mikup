# Best Practices: Rust 1.86 (Stable)

Updated as of: March 5, 2026

## Core Language (v1.86+)
- **Environment:** Codebase and Runtime in WSL2 (Linux). 
- **`std::sync::LazyLock`:** The standard for global audio device handles. Replace `lazy_static` or `once_cell`.
- **Wait-Free Audio Thread:** The audio callback is sacred. 
  - **NO** Allocations (`Box`, `Vec`).
  - **NO** Mutex Locking.
  - **NO** File I/O.
  - **NO** Panics (use `catch_unwind`).
- **Async Closures:** Use for background AI Director analysis without blocking the UI.

## Audio Stack (2026)
### Key Practices:
- **CPAL:** Strictly for hardware stream management and buffer negotiation.
- **Rodio:** For playback management. Use a custom `MikupSource` trait to inject diagnostic hooks into the stream.
- **Lock-Free Concurrency:** Use **`rtrb`** or **`ringbuf`** for all communication between the Vizia UI thread and the Audio callback thread.
- **Symphonia:** The definitive pure-Rust standard for decoding.
- **`std::simd`:** Leverage SIMD for FFT and LUFS calculations in the `mikup-dsp` module.

## Forensic Radar Integration
The Vizia UI thread reads high-density forensic data from the `mikup_payload.json` and visualizes it in the `ForensicRadar` sidebar (Right Column).

### Key Practices:
- **Lens Mapping:** Map the `ProjectSummary` metrics (STOI, nPVI, Speech Rate) to Vizia Lenses.
- **Z-Ordering:** Use a root `ZStack` to overlay the floating AI Bubble (Top Layer) over the 2-column `HStack` (Base Layer).
- **Marker Intersection:** Implement an efficient 1D spatial query (interval tree or sorted list) to detect which `ForensicMarker` is closest to the playhead for "Auto-Focus" behavior in the Radar.
- **Type Safety:** Ensure all metrics coming from Python JSON are strictly typed in Rust using `serde` with `f32` or `Option<f32>`.

## State Sync (Triple-Buffer Pattern)
To visualize diagnostic meters without glitching audio:
1.  **Audio Thread:** Writes raw meter data to a fixed-size atomic buffer.
2.  **Bridge:** A background worker aggregates this data.
3.  **UI Thread:** Vizia Model/Lens system reads this data at 60fps via `ContextProxy`.

## Architecture Guidelines
- **`mikup-audio-core`:** Dedicated crate for hardware interaction.
- **`mikup-dsp`:** Pure math/DSP crate for metric calculation.
- **`native/src/`:** The main Vizia application and view logic.
