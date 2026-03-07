# Mikup Native UI (Vizia) — Design

Date: 2026-03-03

## Goal

Scaffold `native_ui` crate: a Vizia v0.3.0 + cpal audio engine PoC replacing the Tauri/React webview with a GPU-accelerated, lock-free native DAW shell.

## Differs From GPUI PoC

| Axis | GPUI PoC (`poc/gpui_timeline`) | Mikup Native (`native_ui`) |
|------|--------------------------------|----------------------------|
| Framework | GPUI (Zed-internal) | Vizia v0.3.0 (Skia-based) |
| Audio | Simulated timer | Real cpal hardware I/O |
| Resampling | None | Rubato v1.0.1 SincFixedIn |
| Scope | Timeline/transcript PoC | Full DAW shell scaffold |

## Architecture: Store-Model Split

Two isolated state buckets to minimize render invalidation:

| Model | Update Rate | Drives |
|-------|-------------|--------|
| `AudioEngineStore` | 60Hz (rtrb consumer) | LUFS meter, playhead position |
| `AppData` | User input | Transport controls, volume slider |

## File Structure

```
native_ui/
├── Cargo.toml
└── src/
    ├── main.rs            # App bootstrap, Store-Model wiring
    ├── audio_engine.rs    # AudioController, DSP thread, Rubato resampler
    └── waveform_view.rs   # WaveformView custom widget, LOD decimation
```

## Dependencies (exact versions)

```toml
vizia       = "0.3.0"     # Retained-mode, Skia-based GPU rendering
cpal        = "0.17.3"    # Cross-platform hardware audio I/O
rubato      = "1.0.1"     # SincFixedIn for 44.1kHz → hardware rate
rtrb        = "0.3.2"     # SPSC ring buffer (wait-free)
symphonia   = "0.5.5"     # Audio file decode
atomic_float = "1.1.0"   # AtomicF32 for volume parameter
```

## Component Designs

### `audio_engine.rs` — AudioController

- Constructor `new()` pre-allocates all DSP buffers (input, output, resampler scratch).
- Spawns a dedicated background DSP thread (non-realtime setup).
- Audio callback (cpal stream handler) is **zero-allocation**: no `Box`, `Vec`, `String`.
- Volume reads `AtomicF32` with `Ordering::Relaxed`.
- Playhead/LUFS pushed to `AudioEngineStore` via `rtrb::Producer` (wait-free).
- Resampler: `rubato::SincFixedIn` with `SincInterpolationParameters` pre-computed in `new()`.

### `waveform_view.rs` — WaveformView

- Stores pre-computed `Vec<(f32, f32)>` min/max peak table (1 pair per pixel at 1:1 zoom).
- **LOD decimation**: on draw, compute `samples_per_pixel = total_samples / canvas_width`; iterate peak table with stride matching zoom level.
- **Viewport culling**: only iterate peaks within `[scroll_offset, scroll_offset + canvas_width]`.
- **Path cache**: `RefCell<Option<CachedPath>>` where `CachedPath` stores last `(width, scroll, zoom)` key + the built `vizia::vg::Path`. Re-built only on key change.
- Draw signature: `fn draw(&self, cx: &mut DrawContext, canvas: &vizia::vg::Canvas)`.
- Uses `vizia::vg::Paint::color(...)` for waveform fill.

### `main.rs` — Wiring

- `AppData { volume: f32, playing: bool }` — Vizia `Lens`-derived model.
- `AudioEngineStore { lufs: f32, playhead_ms: u64 }` — Vizia `Lens`-derived model, polled at 60Hz via `cx.spawn` event loop.
- Button: `Button::new(cx, |cx| Label::new(cx, "Play/Pause")).on_press(|cx| cx.emit(AppEvent::TogglePlay))`.
- Slider: `.on_change(|cx, val| VOLUME.store(val, Ordering::Relaxed))` wired to `AtomicF32`.

## Concurrency Contract

| Thread | Allowed | Forbidden |
|--------|---------|-----------|
| Audio callback | `AtomicF32::load`, `rtrb::Producer::push` | `Mutex::lock`, heap allocation |
| DSP background | Pre-allocated buffer reuse | Allocation after `new()` |
| UI thread | All Vizia APIs | Blocking on audio thread |

## Acceptance Criteria

- `cargo build` succeeds on Rust 1.82+ (Rust 2024 edition).
- Audio callback: verified by code inspection — no `Box`, `Vec`, `String`, no `Mutex`.
- Waveform: Path cache prevents re-computation when `(width, scroll, zoom)` unchanged.
- 1-hour file at 120 FPS: LOD stride = `total_samples / (canvas_width * 120)` peaks/frame max.
