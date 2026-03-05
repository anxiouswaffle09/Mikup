# Best Practices: Rust 1.86 (Stable)

Updated as of: March 2, 2026

## Core Language (v1.86+)
- **Hybrid Environment:** Codebase in Windows (`/mnt/d/SoftwareDev/Mikup/`); Runtime in WSL2 (Linux). 
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
- **Lock-Free Concurrency:** Use **`rtrb`** or **`ringbuf`** for all communication between the Tauri UI thread and the Audio callback thread.
- **Symphonia:** The definitive pure-Rust standard for decoding.
- **`std::simd`:** Leverage SIMD for FFT and LUFS calculations in the `mikup-dsp` module.

## State Sync (Triple-Buffer Pattern)
To visualize diagnostic meters without glitching audio:
1.  **Audio Thread:** Writes raw meter data to a fixed-size atomic buffer.
2.  **Bridge:** A background worker aggregates this data.
3.  **UI Thread:** Tauri polls/emits this aggregated data at 60fps.

## Architecture Guidelines
- **`mikup-audio-core`:** Dedicated crate for hardware interaction.
- **`mikup-dsp`:** Pure math/DSP crate for metric calculation.
- **`mikup-tauri-bridge`:** Glue layer between Rust and React.
