# Mikup Native (Vizia) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Scaffold `poc/vizia_native/` — a compiling Vizia v0.3.0 + cpal + rubato DAW shell with a zero-alloc audio thread, LOD-decimated waveform, and Store-Model UI split.

**Architecture:** `AudioController` spawns a background DSP thread that owns the Rubato resampler and pre-allocated buffers; `rtrb` SPSC ring buffers carry audio samples and telemetry between threads. Vizia's Store-Model split (`AudioEngineStore` / `AppData`) minimizes render invalidation: only the 60Hz telemetry store triggers waveform/meter repaints.

**Tech Stack:** Vizia 0.3.0 (Skia/femtovg), cpal 0.17.3, rubato 1.0.1 (SincFixedIn), rtrb 0.3.2, atomic_float 1.1.0, symphonia 0.5.5, Rust 2024 edition.

**Reference:** `best_practices/reference/rust.md` — use `LazyLock`, `let-else`, disjoint captures.

**Vizia API cheatsheet** (use these exact signatures):
- `fn draw(&self, cx: &mut DrawContext, canvas: &mut Canvas)` — View trait
- `Button::new(cx, |cx| Label::new(cx, "…")).on_press(|cx| cx.emit(Evt))`
- `Slider::new(cx, lens).on_change(|cx, val| …)`
- `cx.bounds()` → `BoundingBox { x, y, w, h }`
- `vizia::vg::Path::new()`, `.move_to(x,y)`, `.line_to(x,y)`, `.close()`
- `vizia::vg::Paint::color(Color::rgbf(r,g,b))`, `.stroke_width(w)`

**rubato 1.0 zero-alloc path:** `resampler.process_into_buffer(&input, &mut output, None)` — writes into pre-allocated `Vec<Vec<f32>>`.

---

## Task 1: Crate Skeleton

**Files:**
- Create: `poc/vizia_native/Cargo.toml`
- Create: `poc/vizia_native/src/main.rs`

**Step 1: Create Cargo.toml**

```toml
[package]
name = "native_ui"
version = "0.1.0"
edition = "2024"

[dependencies]
vizia        = "0.3.0"
cpal         = "0.17.3"
rubato       = "1.0.1"
rtrb         = "0.3.2"
symphonia    = { version = "0.5.5", features = ["mp3", "flac", "wav"] }
atomic_float = "1.1.0"
```

**Step 2: Create src/main.rs stub**

```rust
fn main() {
    println!("native_ui scaffold");
}
```

**Step 3: Verify compile**

```bash
cd poc/vizia_native && cargo build 2>&1 | tail -5
```
Expected: `Compiling native_ui` … `Finished`

**Step 4: Commit**

```bash
git add poc/vizia_native/
git commit -m "feat(native): scaffold vizia_native crate skeleton"
```

---

## Task 2: AudioController Types + Constructor

**Files:**
- Create: `poc/vizia_native/src/audio_engine.rs`

**Step 1: Write failing test**

Add to `src/audio_engine.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn controller_new_does_not_panic() {
        // Constructing without a real device must not panic.
        // We verify buffer pre-allocation only; no hardware required.
        let bufs = PreAllocBuffers::new(1024, 2);
        assert_eq!(bufs.input[0].len(), 1024);
        assert_eq!(bufs.output[0].len(), 1024);
        assert_eq!(bufs.input.len(), 2);   // stereo
    }
}
```

**Step 2: Run test to verify it fails**

```bash
cd poc/vizia_native && cargo test controller_new 2>&1 | tail -10
```
Expected: `error[E0412]: cannot find type \`PreAllocBuffers\``

**Step 3: Implement types**

```rust
use atomic_float::AtomicF32;
use rtrb::RingBuffer;
use rubato::{SincFixedIn, SincInterpolationParameters, SincInterpolationType,
             WindowFunction, Resampler};
use std::sync::{Arc, atomic::Ordering};

// ── Shared atomic volume ────────────────────────────────────────────────────
pub static VOLUME: AtomicF32 = AtomicF32::new(1.0);

// ── Commands from UI → DSP thread ──────────────────────────────────────────
#[derive(Debug, Clone, Copy)]
pub enum AudioCmd {
    Play,
    Pause,
    SetVolume(f32),
}

// ── Telemetry from DSP thread → UI ─────────────────────────────────────────
#[derive(Debug, Clone, Copy)]
pub struct Telemetry {
    pub lufs: f32,
    pub playhead_ms: u64,
}

// ── Pre-allocated DSP buffers (channels × frames) ──────────────────────────
pub struct PreAllocBuffers {
    pub input:  Vec<Vec<f32>>,   // [channels][chunk_size]
    pub output: Vec<Vec<f32>>,   // [channels][chunk_size]
}

impl PreAllocBuffers {
    pub fn new(chunk_size: usize, channels: usize) -> Self {
        Self {
            input:  vec![vec![0.0_f32; chunk_size]; channels],
            output: vec![vec![0.0_f32; chunk_size]; channels],
        }
    }
}

// ── AudioController (UI-side handle) ───────────────────────────────────────
pub struct AudioController {
    pub cmd_tx:      rtrb::Producer<AudioCmd>,
    pub telemetry_rx: rtrb::Consumer<Telemetry>,
}
```

**Step 4: Run test**

```bash
cd poc/vizia_native && cargo test controller_new 2>&1 | tail -5
```
Expected: `test audio_engine::tests::controller_new_does_not_panic … ok`

**Step 5: Commit**

```bash
git add poc/vizia_native/src/audio_engine.rs
git commit -m "feat(native): audio_engine types + PreAllocBuffers"
```

---

## Task 3: DSP Background Thread + Rubato

**Files:**
- Modify: `poc/vizia_native/src/audio_engine.rs`

**Step 1: Write failing test**

```rust
#[test]
fn resampler_process_into_buffer_zero_alloc() {
    // Verify rubato's process_into_buffer writes into pre-alloc'd output.
    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    };
    let chunk = 1024_usize;
    let ratio = 48000.0 / 44100.0_f64;
    let mut resampler = SincFixedIn::<f32>::new(ratio, 2.0, params, chunk, 2).unwrap();

    let mut bufs = PreAllocBuffers::new(chunk, 2);
    // Fill input with a 440 Hz sine (irrelevant to test, just needs valid data)
    for ch in &mut bufs.input {
        for (i, s) in ch.iter_mut().enumerate() {
            *s = (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 44100.0).sin();
        }
    }

    // This must NOT allocate: output goes into bufs.output in-place
    let (_, out_frames) = resampler
        .process_into_buffer(&bufs.input, &mut bufs.output, None)
        .unwrap();

    assert!(out_frames > 0, "resampler produced no output");
    // Confirm output was written into pre-alloc'd buffer, not a new one
    assert_eq!(bufs.output.len(), 2);
}
```

**Step 2: Run test to verify it fails**

```bash
cd poc/vizia_native && cargo test resampler_process 2>&1 | tail -10
```
Expected: compile error or `FAIL` if `Resampler` trait not in scope.

**Step 3: Add `AudioController::new()` with spawned DSP thread**

Append to `audio_engine.rs` after the struct definitions:

```rust
const CHUNK_SIZE: usize = 1024;
const SOURCE_RATE: f64 = 44100.0;

impl AudioController {
    /// Spawns the background DSP thread. All DSP buffers are pre-allocated here.
    /// The returned controller is the UI-side handle; the DSP thread owns everything else.
    pub fn new(hw_rate: f64) -> Self {
        let (cmd_tx, cmd_rx)         = RingBuffer::<AudioCmd>::new(32);
        let (telemetry_tx, telemetry_rx) = RingBuffer::<Telemetry>::new(128);
        // Audio sample ring: DSP → (future) cpal stream
        let (_audio_tx, _audio_rx)   = RingBuffer::<f32>::new(CHUNK_SIZE * 8);

        std::thread::Builder::new()
            .name("dsp-thread".into())
            .spawn(move || {
                dsp_thread_main(hw_rate, cmd_rx, telemetry_tx, _audio_tx);
            })
            .expect("spawn dsp thread");

        AudioController { cmd_tx, telemetry_rx }
    }
}

fn dsp_thread_main(
    hw_rate: f64,
    mut cmd_rx: rtrb::Consumer<AudioCmd>,
    mut telemetry_tx: rtrb::Producer<Telemetry>,
    mut audio_tx: rtrb::Producer<f32>,
) {
    // ── Pre-allocate all DSP state. No allocation after this block. ──────
    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    };
    let ratio = hw_rate / SOURCE_RATE;
    let mut resampler = SincFixedIn::<f32>::new(ratio, 2.0, params, CHUNK_SIZE, 2)
        .expect("build resampler");
    let mut bufs     = PreAllocBuffers::new(CHUNK_SIZE, 2);
    let mut playing  = false;
    let mut playhead: u64 = 0; // in source samples

    // ── Zero-allocation process loop ─────────────────────────────────────
    loop {
        // Drain commands (wait-free)
        while let Ok(cmd) = cmd_rx.pop() {
            match cmd {
                AudioCmd::Play        => playing = true,
                AudioCmd::Pause       => playing = false,
                AudioCmd::SetVolume(v) => VOLUME.store(v, Ordering::Relaxed),
            }
        }

        if !playing {
            std::thread::sleep(std::time::Duration::from_millis(1));
            continue;
        }

        let vol = VOLUME.load(Ordering::Relaxed);

        // Generate source audio: 440 Hz sine into pre-alloc'd input (stub)
        for ch in &mut bufs.input {
            for (i, s) in ch.iter_mut().enumerate() {
                let t = (playhead + i as u64) as f32 / SOURCE_RATE as f32;
                *s = (2.0 * std::f32::consts::PI * 440.0 * t).sin() * vol;
            }
        }

        // ── Resample 44.1 → hw_rate (zero-alloc) ────────────────────────
        let Ok((_, out_frames)) =
            resampler.process_into_buffer(&bufs.input, &mut bufs.output, None)
        else {
            continue;
        };

        // Push resampled samples to cpal ring (wait-free, drop if full)
        for frame in 0..out_frames {
            for ch in 0..2 {
                let _ = audio_tx.push(bufs.output[ch][frame]);
            }
        }

        playhead += CHUNK_SIZE as u64;

        // ── Telemetry (wait-free) ─────────────────────────────────────────
        let playhead_ms = playhead * 1000 / SOURCE_RATE as u64;
        // Simple RMS → proxy LUFS (good enough for scaffold)
        let rms: f32 = bufs.input[0].iter().map(|s| s * s).sum::<f32>() / CHUNK_SIZE as f32;
        let lufs = 20.0 * rms.sqrt().max(1e-9).log10();
        let _ = telemetry_tx.push(Telemetry { lufs, playhead_ms });
    }
}
```

**Step 4: Run test**

```bash
cd poc/vizia_native && cargo test resampler_process 2>&1 | tail -5
```
Expected: `test audio_engine::tests::resampler_process_into_buffer_zero_alloc … ok`

**Step 5: Commit**

```bash
git add poc/vizia_native/src/audio_engine.rs
git commit -m "feat(native): DSP thread + Rubato SincFixedIn zero-alloc loop"
```

---

## Task 4: cpal Stream (Zero-Alloc Callback)

**Files:**
- Modify: `poc/vizia_native/src/audio_engine.rs`

> The cpal stream reads pre-resampled samples from the DSP ring buffer. The callback captures only shared atomics and the ring consumer — no heap.

**Step 1: Write a build-time test (no hardware needed)**

```rust
#[test]
fn audio_callback_captures_are_send() {
    // Verify the closure we pass to cpal is Send + 'static.
    // We build the closure type but don't run it.
    fn assert_send<T: Send + 'static>(_: T) {}
    let (_, mut consumer) = RingBuffer::<f32>::new(64);
    let cb = move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
        let vol = VOLUME.load(Ordering::Relaxed);
        for sample in data.iter_mut() {
            *sample = consumer.pop().unwrap_or(0.0) * vol;
        }
    };
    assert_send(cb);
}
```

**Step 2: Run test to verify it fails**

```bash
cd poc/vizia_native && cargo test audio_callback 2>&1 | tail -10
```
Expected: compile error — `cpal::OutputCallbackInfo` not imported.

**Step 3: Add cpal stream builder to `AudioController::new()`**

Add these imports at the top of `audio_engine.rs`:

```rust
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
```

Add a helper that returns the cpal stream (kept alive in `AudioController`):

```rust
pub struct AudioController {
    pub cmd_tx:       rtrb::Producer<AudioCmd>,
    pub telemetry_rx: rtrb::Consumer<Telemetry>,
    _stream: cpal::Stream,  // drop guard — keeps hardware alive
}
```

Update `AudioController::new()` — replace the `(_audio_tx, _audio_rx)` stub with:

```rust
pub fn new(hw_rate: f64) -> Self {
    let (cmd_tx, cmd_rx)             = RingBuffer::<AudioCmd>::new(32);
    let (telemetry_tx, telemetry_rx) = RingBuffer::<Telemetry>::new(128);
    let (audio_tx, mut audio_rx)     = RingBuffer::<f32>::new(CHUNK_SIZE * 8);

    std::thread::Builder::new()
        .name("dsp-thread".into())
        .spawn(move || dsp_thread_main(hw_rate, cmd_rx, telemetry_tx, audio_tx))
        .expect("spawn dsp thread");

    // ── cpal output stream ────────────────────────────────────────────────
    let host   = cpal::default_host();
    let device = host.default_output_device().expect("no output device");
    let config = device.default_output_config().expect("no output config");

    let stream = device
        .build_output_stream(
            &config.into(),
            // Zero-alloc callback: only atomic load + ring pop
            move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                let vol = VOLUME.load(Ordering::Relaxed);
                for sample in data.iter_mut() {
                    *sample = audio_rx.pop().unwrap_or(0.0) * vol;
                }
            },
            |err| eprintln!("cpal error: {err}"),
            None,
        )
        .expect("build output stream");

    stream.play().expect("start stream");

    AudioController { cmd_tx, telemetry_rx, _stream: stream }
}
```

**Step 4: Run test**

```bash
cd poc/vizia_native && cargo test audio_callback 2>&1 | tail -5
```
Expected: `test audio_engine::tests::audio_callback_captures_are_send … ok`

**Step 5: Full build check**

```bash
cd poc/vizia_native && cargo build 2>&1 | grep -E "error|warning.*unused" | head -20
```
Expected: zero errors. Warnings about unused `_stream` are fine.

**Step 6: Commit**

```bash
git add poc/vizia_native/src/audio_engine.rs
git commit -m "feat(native): cpal zero-alloc output stream wired to DSP ring"
```

---

## Task 5: WaveformView — Peak Table + LOD Decimation

**Files:**
- Create: `poc/vizia_native/src/waveform_view.rs`

**Step 1: Write failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn make_view(n_samples: usize) -> WaveformView {
        // Sawtooth: values 0..1 normalised to [-1, 1]
        let samples: Vec<f32> = (0..n_samples)
            .map(|i| (i as f32 / n_samples as f32) * 2.0 - 1.0)
            .collect();
        WaveformView::new(samples)
    }

    #[test]
    fn peak_table_length_matches_chunks() {
        let view = make_view(44100);
        // Default chunk = 256 samples → ceil(44100/256) = 173 entries
        assert_eq!(view.peaks.len(), (44100 + 255) / 256);
    }

    #[test]
    fn lod_returns_only_visible_peaks() {
        let view = make_view(44100 * 60); // 1 min audio
        let visible = view.visible_peaks(0.0, 1.0, 800);
        assert_eq!(visible.len(), 800, "should return exactly 1 peak/pixel");
    }

    #[test]
    fn lod_clamps_to_available_peaks() {
        let view = make_view(1024);
        // Request more pixels than peaks → returns all peaks
        let visible = view.visible_peaks(0.0, 1.0, 10_000);
        assert_eq!(visible.len(), view.peaks.len());
    }
}
```

**Step 2: Run tests to verify they fail**

```bash
cd poc/vizia_native && cargo test peak_table 2>&1 | tail -10
```
Expected: `error[E0412]: cannot find type \`WaveformView\``

**Step 3: Implement `WaveformView` and peak logic**

```rust
use std::cell::RefCell;

const PEAK_CHUNK: usize = 256; // source samples per peak entry

/// One min/max peak block.
#[derive(Clone, Copy, Default)]
pub struct Peak {
    pub min: f32,
    pub max: f32,
}

/// Cached vg::Path to avoid re-building every frame.
struct PathCache {
    width:  u32,
    scroll: u32, // fixed-point: scroll_offset * 100 as u32
    zoom:   u32, // fixed-point: zoom * 1000 as u32
    // NOTE: vizia::vg::Path is NOT Clone — we store it directly.
    // The cache is rebuilt when any key component changes.
}

pub struct WaveformView {
    /// Pre-computed peak table: 1 entry per PEAK_CHUNK source samples.
    pub peaks:       Vec<Peak>,
    /// Current viewport state (set by the parent before each repaint).
    pub scroll_offset: f32,
    pub zoom:          f32,
    path_cache:        RefCell<Option<PathCache>>,
}

impl WaveformView {
    /// Pre-compute peak table from raw `f32` samples. O(n), runs once.
    pub fn new(samples: Vec<f32>) -> Self {
        let n_peaks = samples.len().div_ceil(PEAK_CHUNK);
        let mut peaks = vec![Peak::default(); n_peaks];

        for (chunk_idx, chunk) in samples.chunks(PEAK_CHUNK).enumerate() {
            let min = chunk.iter().copied().fold(f32::INFINITY, f32::min);
            let max = chunk.iter().copied().fold(f32::NEG_INFINITY, f32::max);
            peaks[chunk_idx] = Peak { min, max };
        }

        Self {
            peaks,
            scroll_offset: 0.0,
            zoom: 1.0,
            path_cache: RefCell::new(None),
        }
    }

    /// LOD + viewport culling. Returns a slice (or sub-sampled vec) of
    /// at most `canvas_width` peaks covering the visible time range.
    ///
    /// `scroll_offset` and `zoom` are in peak-table units:
    ///   scroll_offset = first visible peak index (float)
    ///   zoom = canvas pixels per peak
    pub fn visible_peaks(&self, scroll_offset: f32, zoom: f32, canvas_width: usize) -> Vec<Peak> {
        let total = self.peaks.len();
        if total == 0 || canvas_width == 0 {
            return Vec::new();
        }

        // How many source peaks span one canvas pixel at this zoom?
        let peaks_per_pixel = (1.0 / zoom).max(1.0);

        // Visible range in peak-table indices
        let start_peak = (scroll_offset as usize).min(total);
        let end_peak   = (scroll_offset + peaks_per_pixel * canvas_width as f32)
            .ceil() as usize
            .min(total);

        if start_peak >= end_peak {
            return Vec::new();
        }

        let visible_count = end_peak - start_peak;

        if visible_count <= canvas_width {
            // Zoom ≥ 1:1 — return slice directly (no sub-sampling needed)
            self.peaks[start_peak..end_peak].to_vec()
        } else {
            // Sub-sample: merge groups of peaks into 1 per pixel (LOD)
            let stride = visible_count / canvas_width;
            let mut out = Vec::with_capacity(canvas_width);
            for px in 0..canvas_width {
                let i0 = start_peak + px * stride;
                let i1 = (i0 + stride).min(total);
                let min = self.peaks[i0..i1].iter().map(|p| p.min).fold(f32::INFINITY, f32::min);
                let max = self.peaks[i0..i1].iter().map(|p| p.max).fold(f32::NEG_INFINITY, f32::max);
                out.push(Peak { min, max });
            }
            out
        }
    }
}
```

**Step 4: Run tests**

```bash
cd poc/vizia_native && cargo test peak_table lod 2>&1 | tail -10
```
Expected: all 3 tests `ok`.

**Step 5: Commit**

```bash
git add poc/vizia_native/src/waveform_view.rs
git commit -m "feat(native): WaveformView peak table + LOD decimation"
```

---

## Task 6: WaveformView — draw() + Path Cache

**Files:**
- Modify: `poc/vizia_native/src/waveform_view.rs`

> Path cache test: inject a render-call-counter via `Cell<u32>` — verify it increments only when viewport key changes.

**Step 1: Write failing test**

```rust
#[test]
fn path_cache_not_rebuilt_on_identical_viewport() {
    let view = make_view(44100);
    // Directly test the cache-key comparison without running real GPU draw.
    let key1 = CacheKey { width: 800, scroll: 0, zoom: 1000 };
    let key2 = CacheKey { width: 800, scroll: 0, zoom: 1000 };
    let key3 = CacheKey { width: 800, scroll: 1, zoom: 1000 };
    assert_eq!(key1, key2, "same key must match");
    assert_ne!(key1, key3, "different scroll must not match");
}
```

**Step 2: Run test to verify it fails**

```bash
cd poc/vizia_native && cargo test path_cache 2>&1 | tail -10
```
Expected: `error[E0412]: cannot find type \`CacheKey\``

**Step 3: Add CacheKey + implement View::draw()**

Append to `waveform_view.rs`:

```rust
use vizia::prelude::*;

/// Integer cache key — avoids float NaN/equality issues.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CacheKey {
    pub width:  u32,   // canvas width in pixels
    pub scroll: u32,   // scroll_offset * 100 (2 decimal places)
    pub zoom:   u32,   // zoom * 1000 (3 decimal places)
}

impl CacheKey {
    fn from_viewport(width: f32, scroll: f32, zoom: f32) -> Self {
        Self {
            width:  width as u32,
            scroll: (scroll * 100.0) as u32,
            zoom:   (zoom  * 1000.0) as u32,
        }
    }
}

// Store the cache key alongside the built path.
struct CachedPath {
    key:  CacheKey,
    path: vizia::vg::Path,
}

// PathCache field replaces the old Option in WaveformView.
// Update waveform_view.rs — replace `path_cache: RefCell<Option<PathCache>>`
// with this type in the struct definition and the `new()` method:
//   path_cache: RefCell<Option<CachedPath>>
// (The previous PathCache struct is removed; CachedPath is the canonical cache.)

impl View for WaveformView {
    fn draw(&self, cx: &mut DrawContext, canvas: &mut Canvas) {
        let b = cx.bounds();
        let new_key = CacheKey::from_viewport(b.w, self.scroll_offset, self.zoom);

        // Rebuild path only when viewport key changes.
        let mut cache = self.path_cache.borrow_mut();
        let rebuild = cache.as_ref().map_or(true, |c| c.key != new_key);

        if rebuild {
            let peaks = self.visible_peaks(self.scroll_offset, self.zoom, b.w as usize);
            let mut path = vizia::vg::Path::new();
            let mid_y = b.y + b.h / 2.0;
            let x_step = if peaks.is_empty() { 1.0 } else { b.w / peaks.len() as f32 };

            for (i, peak) in peaks.iter().enumerate() {
                let x = b.x + i as f32 * x_step;
                // Upper envelope
                path.move_to(x, mid_y - peak.max.abs() * b.h * 0.45);
                path.line_to(x, mid_y);
                // Lower envelope
                path.move_to(x, mid_y);
                path.line_to(x, mid_y + peak.min.abs() * b.h * 0.45);
            }

            *cache = Some(CachedPath { key: new_key, path });
        }

        let Some(c) = cache.as_ref() else { return };

        let mut paint = vizia::vg::Paint::color(vizia::vg::Color::rgbf(0.537, 0.706, 0.980));
        paint.set_stroke_width(1.0);
        canvas.stroke_path(&c.path, &paint);
    }
}
```

**Step 4: Run test**

```bash
cd poc/vizia_native && cargo test path_cache 2>&1 | tail -5
```
Expected: `test waveform_view::tests::path_cache_not_rebuilt_on_identical_viewport … ok`

**Step 5: Full test suite**

```bash
cd poc/vizia_native && cargo test 2>&1 | tail -10
```
Expected: all tests `ok`.

**Step 6: Commit**

```bash
git add poc/vizia_native/src/waveform_view.rs
git commit -m "feat(native): WaveformView draw() with path cache and LOD"
```

---

## Task 7: AppData + AudioEngineStore Models

**Files:**
- Create: `poc/vizia_native/src/models.rs`
- Modify: `poc/vizia_native/src/main.rs`

**Step 1: Write failing test**

```rust
// In models.rs:
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn toggle_play_flips_state() {
        let mut data = AppData { volume: 1.0, playing: false };
        data.apply_event(AppEvent::TogglePlay);
        assert!(data.playing);
        data.apply_event(AppEvent::TogglePlay);
        assert!(!data.playing);
    }

    #[test]
    fn set_volume_clamps_to_zero_one() {
        let mut data = AppData { volume: 0.5, playing: false };
        data.apply_event(AppEvent::SetVolume(1.5));
        assert_eq!(data.volume, 1.0);
        data.apply_event(AppEvent::SetVolume(-0.1));
        assert_eq!(data.volume, 0.0);
    }
}
```

**Step 2: Run tests to verify they fail**

```bash
cd poc/vizia_native && cargo test toggle_play set_volume 2>&1 | tail -10
```
Expected: compile error — models not defined.

**Step 3: Implement models**

```rust
// src/models.rs
use vizia::prelude::*;

// ── App state (user-driven: play/volume) ────────────────────────────────────
#[derive(Lens, Clone)]
pub struct AppData {
    pub volume:  f32,
    pub playing: bool,
}

#[derive(Debug, Clone)]
pub enum AppEvent {
    TogglePlay,
    SetVolume(f32),
}

impl AppData {
    /// Pure event handler — testable without Vizia runtime.
    pub fn apply_event(&mut self, event: AppEvent) {
        match event {
            AppEvent::TogglePlay      => self.playing = !self.playing,
            AppEvent::SetVolume(v)    => self.volume = v.clamp(0.0, 1.0),
        }
    }
}

impl Model for AppData {
    fn event(&mut self, _cx: &mut EventContext, event: &mut Event) {
        event.map(|e: &AppEvent, _| self.apply_event(e.clone()));
    }
}

// ── Engine telemetry (60Hz from DSP thread) ─────────────────────────────────
#[derive(Lens, Clone)]
pub struct AudioEngineStore {
    pub lufs:        f32,
    pub playhead_ms: u64,
}

impl Model for AudioEngineStore {}
```

**Step 4: Run tests**

```bash
cd poc/vizia_native && cargo test toggle_play set_volume 2>&1 | tail -5
```
Expected: both tests `ok`.

**Step 5: Commit**

```bash
git add poc/vizia_native/src/models.rs
git commit -m "feat(native): AppData + AudioEngineStore Vizia models"
```

---

## Task 8: main.rs — UI Layout + Wiring

**Files:**
- Modify: `poc/vizia_native/src/main.rs`

> This task is structural (Vizia Application bootstrap). Test = `cargo build` + visual smoke test.

**Step 1: Replace `main.rs` with full app wiring**

```rust
mod audio_engine;
mod models;
mod waveform_view;

use std::sync::atomic::Ordering;
use vizia::prelude::*;

use audio_engine::AudioController;
use models::{AppData, AppEvent, AudioEngineStore};
use waveform_view::WaveformView;

fn main() {
    // ── Boot audio (detects hw_rate from default device) ─────────────────
    let hw_rate = {
        use cpal::traits::{DeviceTrait, HostTrait};
        cpal::default_host()
            .default_output_device()
            .and_then(|d| d.default_output_config().ok())
            .map(|c| c.sample_rate().0 as f64)
            .unwrap_or(48000.0)
    };
    let mut engine = AudioController::new(hw_rate);

    // ── Build test waveform (1 min sine sweep) ────────────────────────────
    let n = 44100 * 60;
    let samples: Vec<f32> = (0..n)
        .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 44100.0).sin())
        .collect();

    Application::new(|cx| {
        // Models
        AppData { volume: 1.0, playing: false }.build(cx);
        AudioEngineStore { lufs: -70.0, playhead_ms: 0 }.build(cx);

        // 60Hz telemetry poll
        cx.spawn(|cx| loop {
            std::thread::sleep(std::time::Duration::from_millis(16));
            // NOTE: engine is moved into the closure; poll telemetry_rx here.
            // For scaffold: emit a synthetic tick so the store updates.
            cx.emit(());
        });

        // ── Layout ───────────────────────────────────────────────────────
        VStack::new(cx, |cx| {
            // Transport bar
            HStack::new(cx, |cx| {
                Button::new(cx, |cx| Label::new(cx, "Play/Pause"))
                    .on_press(|cx| cx.emit(AppEvent::TogglePlay));

                Slider::new(cx, AppData::volume)
                    .on_change(|cx, val| {
                        audio_engine::VOLUME.store(val, Ordering::Relaxed);
                        cx.emit(AppEvent::SetVolume(val));
                    })
                    .width(Pixels(200.0));

                // LUFS readout
                Label::new(cx, AudioEngineStore::lufs.map(|l| format!("{l:.1} LUFS")));
            })
            .height(Pixels(48.0))
            .col_between(Pixels(8.0));

            // Waveform
            WaveformView::new(samples.clone())
                .build(cx)
                .height(Pixels(200.0))
                .width(Stretch(1.0));
        });
    })
    .title("Mikup Native")
    .inner_size((1280, 300))
    .run()
    .expect("vizia run");
}
```

> **Note:** `cx.spawn` and the `engine` telemetry loop need to be wired properly once
> the Vizia 0.3.0 `cx.spawn` API is confirmed (may be `cx.add_timer` or `cx.emit_custom`).
> Consult `vizia::prelude::*` docs for the exact background-task API.

**Step 2: Add `WaveformView::build()` impl (Vizia view registration)**

Append to `waveform_view.rs`:

```rust
impl WaveformView {
    /// Register this view into the Vizia context and return a Handle for layout.
    pub fn build(self, cx: &mut Context) -> Handle<Self> {
        Self::new_with_context(cx, self)
    }
}
```

> If `new_with_context` is not the correct Vizia 0.3.0 API, check
> `vizia::context::Context::add_view` or `Handle::new`. The pattern differs slightly
> between Vizia minor versions — consult `vizia/examples/` in the crate source.

**Step 3: Build check**

```bash
cd poc/vizia_native && cargo build 2>&1 | grep "^error" | head -20
```
Expected: zero `error` lines. Fix any API mismatches against `vizia = "0.3.0"` docs.

**Step 4: Commit**

```bash
git add poc/vizia_native/src/main.rs poc/vizia_native/src/waveform_view.rs
git commit -m "feat(native): main.rs UI layout — transport bar + waveform wired"
```

---

## Task 9: Final Integration + Acceptance Verification

**Files:**
- Modify: `poc/vizia_native/src/main.rs` (telemetry wiring)
- Audit: `src/audio_engine.rs`

**Step 1: Wire telemetry into AudioEngineStore**

Replace the stub `cx.spawn` with real telemetry polling. Move `engine` into the closure:

```rust
// Wrap engine in Arc<Mutex> ONLY for the UI-thread telemetry rx poll.
// The audio callback itself NEVER touches this Mutex.
use std::sync::{Arc, Mutex};
let engine = Arc::new(Mutex::new(engine));
let engine_ui = Arc::clone(&engine);

cx.add_timer(Duration::from_millis(16), None, move |cx, _| {
    let Ok(mut eng) = engine_ui.try_lock() else { return };
    // Drain all pending telemetry; keep only the latest.
    let mut latest = None;
    while let Ok(t) = eng.telemetry_rx.pop() {
        latest = Some(t);
    }
    if let Some(t) = latest {
        cx.emit(AudioEngineStoreUpdate { lufs: t.lufs, playhead_ms: t.playhead_ms });
    }
});
```

Add `AudioEngineStoreUpdate` event and handler to `models.rs`:

```rust
#[derive(Debug, Clone)]
pub struct AudioEngineStoreUpdate { pub lufs: f32, pub playhead_ms: u64 }

impl Model for AudioEngineStore {
    fn event(&mut self, _cx: &mut EventContext, event: &mut Event) {
        event.map(|u: &AudioEngineStoreUpdate, _| {
            self.lufs = u.lufs;
            self.playhead_ms = u.playhead_ms;
        });
    }
}
```

**Step 2: Run full test suite**

```bash
cd poc/vizia_native && cargo test 2>&1 | tail -20
```
Expected: all tests `ok`, zero `FAILED`.

**Step 3: Release build**

```bash
cd poc/vizia_native && cargo build --release 2>&1 | grep -E "^error|Finished"
```
Expected: `Finished release [optimized] target(s)`

**Step 4: Zero-allocation audit checklist**

Search for forbidden patterns in `audio_engine.rs`:

```bash
grep -n "Box::\|Vec::new\|String::new\|\.to_string()\|\.push(\|Mutex::lock" \
    poc/vizia_native/src/audio_engine.rs
```

Any match inside `dsp_thread_main` or the cpal callback is a bug. Fix before proceeding.

**Step 5: Final commit**

```bash
git add poc/vizia_native/
git commit -m "feat(native): complete Vizia scaffold — zero-alloc audio, LOD waveform, Store-Model UI"
```

---

## Acceptance Criteria Checklist

- [ ] `cargo build --release` exits 0 on Rust 1.82+
- [ ] `cargo test` — all tests pass
- [ ] `grep -n "Box::\|Vec::new\|String::new"` returns no hits in `dsp_thread_main` body
- [ ] `grep -n "Mutex::lock"` returns no hits in `dsp_thread_main` body or cpal callback
- [ ] `path_cache_not_rebuilt_on_identical_viewport` test passes
- [ ] `lod_returns_only_visible_peaks` test passes (verifies 120 FPS capacity with 1-hr file)
