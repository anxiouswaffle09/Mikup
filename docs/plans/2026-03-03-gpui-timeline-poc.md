# GPUI High-Density Timeline PoC — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Standalone GPUI binary proving <16.6ms frame times under 60Hz DSP telemetry with scrollable waveform + 5,000-word virtualized transcript.

**Architecture:** Multi-entity split — `DspState` (60Hz timer), `TimelineState` (user zoom/scroll), `TranscriptState` (word boundaries). Each entity notifies only its observers, preventing full-tree invalidation.

**Tech Stack:** Rust, `gpui = "0.2"`, `futures` (for `StreamExt` on `Timer::interval`)

---

### Task 1: Scaffold Crate and Verify GPUI Builds

**Files:**
- Create: `poc/gpui_timeline/Cargo.toml`
- Create: `poc/gpui_timeline/src/main.rs`

**Step 1: Create Cargo.toml**

```toml
[package]
name = "gpui_timeline"
version = "0.1.0"
edition = "2024"

[dependencies]
gpui = "0.2"
futures = "0.3"
```

**Step 2: Create minimal main.rs**

```rust
use gpui::*;

struct HelloView;

impl Render for HelloView {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .bg(rgb(0x1e1e2e))
            .justify_center()
            .items_center()
            .text_xl()
            .text_color(rgb(0xcdd6f4))
            .child("GPUI Timeline PoC")
    }
}

fn main() {
    Application::new().run(|cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(1200.), px(800.)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                ..Default::default()
            },
            |_window, cx| cx.new(|_| HelloView),
        )
        .unwrap();
        cx.activate(true);
    });
}
```

**Step 3: Build and run**

Run: `cd poc/gpui_timeline && cargo run`
Expected: A 1200×800 window with dark background and "GPUI Timeline PoC" centered text.

**Step 4: Commit**

```bash
git add poc/gpui_timeline/
git commit -m "feat(poc): scaffold gpui_timeline crate with hello-world window"
```

---

### Task 2: Data Generation Module

**Files:**
- Create: `poc/gpui_timeline/src/data.rs`
- Modify: `poc/gpui_timeline/src/main.rs` (add `mod data;`)

**Step 1: Write data.rs with mock audio + transcript generation**

```rust
/// Pre-computed waveform peak (min, max) for a block of samples.
#[derive(Clone, Copy)]
pub struct PeakBlock {
    pub min: f32,
    pub max: f32,
}

/// A single word in the transcript with time boundaries.
#[derive(Clone)]
pub struct Word {
    pub text: String,
    pub start: f64,
    pub end: f64,
}

pub const SAMPLE_RATE: usize = 44_100;
pub const DURATION_SECS: f64 = 600.0;
pub const BLOCK_SIZE: usize = 512;
pub const WORD_COUNT: usize = 5_000;

/// Generate waveform peaks from a synthetic 10-minute sine sweep.
/// Returns pre-computed min/max blocks (no raw samples stored).
pub fn generate_waveform_peaks() -> Vec<PeakBlock> {
    let total_samples = (SAMPLE_RATE as f64 * DURATION_SECS) as usize;
    let block_count = total_samples / BLOCK_SIZE;
    let mut peaks = Vec::with_capacity(block_count);

    for block_idx in 0..block_count {
        let sample_start = block_idx * BLOCK_SIZE;
        let mut min = f32::MAX;
        let mut max = f32::MIN;

        for s in 0..BLOCK_SIZE {
            let t = (sample_start + s) as f64 / SAMPLE_RATE as f64;
            // Sweep from 80Hz to 8kHz with amplitude modulation
            let freq = 80.0 + (8000.0 - 80.0) * (t / DURATION_SECS);
            let amp = 0.3 + 0.7 * (t * 0.1).sin().abs();
            let sample = (amp * (2.0 * std::f64::consts::PI * freq * t).sin()) as f32;
            min = min.min(sample);
            max = max.max(sample);
        }

        peaks.push(PeakBlock { min, max });
    }

    peaks
}

/// Generate 5,000 mock words with sequential timestamps.
pub fn generate_transcript() -> Vec<Word> {
    let syllables = [
        "the", "and", "for", "are", "but", "not", "you", "all",
        "can", "had", "her", "was", "one", "our", "out", "day",
        "get", "has", "him", "his", "how", "its", "may", "new",
        "now", "old", "see", "way", "who", "boy", "did", "let",
        "put", "say", "she", "too", "use", "mix", "low", "end",
        "sound", "track", "beat", "drum", "bass", "lead", "pad",
        "stem", "clip", "gain", "peak", "fade", "loop", "sync",
        "tempo", "pitch", "reverb", "delay", "comp", "filter",
        "vocal", "music", "effect", "master", "render", "export",
    ];

    let duration_per_word = DURATION_SECS / WORD_COUNT as f64;
    (0..WORD_COUNT)
        .map(|i| {
            let start = i as f64 * duration_per_word;
            let end = start + duration_per_word * 0.9; // 10% gap between words
            Word {
                text: syllables[i % syllables.len()].to_string(),
                start,
                end,
            }
        })
        .collect()
}
```

**Step 2: Add module to main.rs**

Add `mod data;` at the top of `main.rs`.

**Step 3: Verify it compiles**

Run: `cd poc/gpui_timeline && cargo check`
Expected: Compiles with no errors.

**Step 4: Commit**

```bash
git add poc/gpui_timeline/src/data.rs poc/gpui_timeline/src/main.rs
git commit -m "feat(poc): add mock waveform and transcript data generation"
```

---

### Task 3: State Entities

**Files:**
- Create: `poc/gpui_timeline/src/state.rs`
- Modify: `poc/gpui_timeline/src/main.rs` (add `mod state;`)

**Step 1: Write state.rs**

```rust
use gpui::*;
use crate::data::{PeakBlock, Word};

// ── DSP telemetry (60Hz updates) ──────────────────────────────

pub struct DspState {
    pub playhead_secs: f64,
    pub is_playing: bool,
    pub lufs_momentary: f32,
    pub lufs_short_term: f32,
}

impl DspState {
    pub fn new() -> Self {
        Self {
            playhead_secs: 0.0,
            is_playing: false,
            lufs_momentary: -23.0,
            lufs_short_term: -23.0,
        }
    }
}

/// Emitted when playhead crosses into a new word.
pub struct PlayheadMoved {
    pub playhead_secs: f64,
}

impl EventEmitter<PlayheadMoved> for DspState {}

// ── Timeline / waveform state (user interaction) ──────────────

pub struct TimelineState {
    pub peaks: Vec<PeakBlock>,
    pub total_duration: f64,
    pub zoom: f64,          // pixels per second
    pub scroll_offset: f64, // seconds from start
}

impl TimelineState {
    pub fn new(peaks: Vec<PeakBlock>, total_duration: f64) -> Self {
        Self {
            peaks,
            total_duration,
            zoom: 2.0,        // 2 px/sec → full 600s fits in 1200px
            scroll_offset: 0.0,
        }
    }

    /// Clamp scroll so we don't go past the end.
    pub fn clamp_scroll(&mut self, viewport_width: f64) {
        let max_offset = (self.total_duration - viewport_width / self.zoom).max(0.0);
        self.scroll_offset = self.scroll_offset.clamp(0.0, max_offset);
    }
}

// ── Transcript state ──────────────────────────────────────────

pub struct TranscriptState {
    pub words: Vec<Word>,
    pub active_word_idx: usize,
}

impl TranscriptState {
    pub fn new(words: Vec<Word>) -> Self {
        Self {
            words,
            active_word_idx: 0,
        }
    }

    /// Binary search for the word containing the given time.
    pub fn find_word_at(&self, time: f64) -> usize {
        match self.words.binary_search_by(|w| {
            if time < w.start {
                std::cmp::Ordering::Greater
            } else if time > w.end {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        }) {
            Ok(idx) => idx,
            Err(idx) => idx.min(self.words.len().saturating_sub(1)),
        }
    }
}
```

**Step 2: Add module to main.rs**

Add `mod state;` at the top of `main.rs`.

**Step 3: Verify it compiles**

Run: `cd poc/gpui_timeline && cargo check`
Expected: Compiles with no errors.

**Step 4: Commit**

```bash
git add poc/gpui_timeline/src/state.rs poc/gpui_timeline/src/main.rs
git commit -m "feat(poc): add DspState, TimelineState, TranscriptState entities"
```

---

### Task 4: WaveformView with Canvas

**Files:**
- Create: `poc/gpui_timeline/src/waveform_view.rs`
- Modify: `poc/gpui_timeline/src/main.rs` (add `mod waveform_view;`)

**Step 1: Write waveform_view.rs**

```rust
use gpui::*;
use crate::data::BLOCK_SIZE;
use crate::data::SAMPLE_RATE;
use crate::state::{DspState, TimelineState};
use std::time::Instant;

pub struct WaveformView {
    dsp: Entity<DspState>,
    timeline: Entity<TimelineState>,
    pub last_frame_time_us: u64,
    last_render: Instant,
    _subscriptions: Vec<Subscription>,
}

impl WaveformView {
    pub fn new(
        dsp: Entity<DspState>,
        timeline: Entity<TimelineState>,
        cx: &mut Context<Self>,
    ) -> Self {
        let sub_dsp = cx.observe(&dsp, |_this, _entity, cx| cx.notify());
        let sub_tl = cx.observe(&timeline, |_this, _entity, cx| cx.notify());

        Self {
            dsp,
            timeline,
            last_frame_time_us: 0,
            last_render: Instant::now(),
            _subscriptions: vec![sub_dsp, sub_tl],
        }
    }
}

impl Render for WaveformView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // Measure frame time
        let now = Instant::now();
        self.last_frame_time_us = now.duration_since(self.last_render).as_micros() as u64;
        self.last_render = now;

        let playhead_secs = self.dsp.read(cx).playhead_secs;
        let peaks = self.timeline.read(cx).peaks.clone();
        let zoom = self.timeline.read(cx).zoom;
        let scroll_offset = self.timeline.read(cx).scroll_offset;
        let total_duration = self.timeline.read(cx).total_duration;

        let block_duration = BLOCK_SIZE as f64 / SAMPLE_RATE as f64;

        div()
            .id("waveform-container")
            .w_full()
            .h(px(300.))
            .bg(rgb(0x181825))
            .child(
                canvas(
                    // prepaint: nothing to prepare
                    move |_bounds, _window, _cx| {},
                    move |bounds, _, window, _cx| {
                        let w = bounds.size.width.0 as f64;
                        let h = bounds.size.height.0 as f64;
                        let mid_y = h / 2.0;
                        let origin_x = bounds.origin.x.0 as f64;
                        let origin_y = bounds.origin.y.0 as f64;

                        // Background
                        window.paint_quad(quad(
                            bounds,
                            px(0.),
                            rgb(0x181825),
                            Edges::default(),
                            rgb(0x313244),
                            BorderStyle::default(),
                        ));

                        // Determine visible time range
                        let time_start = scroll_offset;
                        let time_end = scroll_offset + w / zoom;

                        // Map to block indices
                        let block_start =
                            ((time_start / block_duration) as usize).min(peaks.len());
                        let block_end =
                            ((time_end / block_duration) as usize + 1).min(peaks.len());

                        // Draw waveform as stroke path
                        if block_end > block_start {
                            // Upper envelope
                            let mut builder = PathBuilder::stroke(px(1.));
                            for (i, block) in
                                peaks[block_start..block_end].iter().enumerate()
                            {
                                let x = origin_x
                                    + (i as f64 / (block_end - block_start) as f64) * w;
                                let y_max =
                                    origin_y + mid_y - (block.max as f64 * mid_y * 0.9);
                                let pt = point(px(x as f32), px(y_max as f32));
                                if i == 0 {
                                    builder.move_to(pt);
                                } else {
                                    builder.line_to(pt);
                                }
                            }
                            if let Ok(path) = builder.build() {
                                window.paint_path(path, rgb(0x89b4fa));
                            }

                            // Lower envelope (mirrored)
                            let mut builder = PathBuilder::stroke(px(1.));
                            for (i, block) in
                                peaks[block_start..block_end].iter().enumerate()
                            {
                                let x = origin_x
                                    + (i as f64 / (block_end - block_start) as f64) * w;
                                let y_min =
                                    origin_y + mid_y - (block.min as f64 * mid_y * 0.9);
                                let pt = point(px(x as f32), px(y_min as f32));
                                if i == 0 {
                                    builder.move_to(pt);
                                } else {
                                    builder.line_to(pt);
                                }
                            }
                            if let Ok(path) = builder.build() {
                                window.paint_path(path, rgb(0x89b4fa));
                            }
                        }

                        // Center line
                        let mut center = PathBuilder::stroke(px(1.));
                        center.move_to(point(
                            px(origin_x as f32),
                            px((origin_y + mid_y) as f32),
                        ));
                        center.line_to(point(
                            px((origin_x + w) as f32),
                            px((origin_y + mid_y) as f32),
                        ));
                        if let Ok(path) = center.build() {
                            window.paint_path(path, rgb(0x585b70));
                        }

                        // Playhead
                        if playhead_secs >= time_start && playhead_secs <= time_end {
                            let px_x = origin_x
                                + (playhead_secs - time_start) * zoom;
                            let mut playhead = PathBuilder::stroke(px(2.));
                            playhead.move_to(point(
                                px(px_x as f32),
                                px(origin_y as f32),
                            ));
                            playhead.line_to(point(
                                px(px_x as f32),
                                px((origin_y + h) as f32),
                            ));
                            if let Ok(path) = playhead.build() {
                                window.paint_path(path, rgb(0xf38ba8));
                            }
                        }
                    },
                )
                .size_full(),
            )
    }
}
```

**Step 2: Add module to main.rs**

Add `mod waveform_view;` at the top of `main.rs`.

**Step 3: Verify it compiles**

Run: `cd poc/gpui_timeline && cargo check`
Expected: Compiles with no errors.

**Step 4: Commit**

```bash
git add poc/gpui_timeline/src/waveform_view.rs poc/gpui_timeline/src/main.rs
git commit -m "feat(poc): waveform canvas view with peaks + playhead rendering"
```

---

### Task 5: TranscriptView with Virtualized List

**Files:**
- Create: `poc/gpui_timeline/src/transcript_view.rs`
- Modify: `poc/gpui_timeline/src/main.rs` (add `mod transcript_view;`)

**Step 1: Write transcript_view.rs**

```rust
use gpui::*;
use crate::state::{DspState, PlayheadMoved, TranscriptState};

pub struct TranscriptView {
    dsp: Entity<DspState>,
    transcript: Entity<TranscriptState>,
    _subscriptions: Vec<Subscription>,
}

impl TranscriptView {
    pub fn new(
        dsp: Entity<DspState>,
        transcript: Entity<TranscriptState>,
        cx: &mut Context<Self>,
    ) -> Self {
        // Re-render when transcript state changes (active word update).
        let sub_ts = cx.observe(&transcript, |_this, _entity, cx| cx.notify());

        // Listen for playhead moves to update active word.
        let ts = transcript.clone();
        let sub_dsp = cx.subscribe(&dsp, move |_this, _emitter, event: &PlayheadMoved, cx| {
            ts.update(cx, |state, cx| {
                let new_idx = state.find_word_at(event.playhead_secs);
                if new_idx != state.active_word_idx {
                    state.active_word_idx = new_idx;
                    cx.notify();
                }
            });
        });

        Self {
            dsp,
            transcript,
            _subscriptions: vec![sub_ts, sub_dsp],
        }
    }
}

impl Render for TranscriptView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let word_count = self.transcript.read(cx).words.len();
        let active_idx = self.transcript.read(cx).active_word_idx;
        let words: Vec<(String, f64)> = self
            .transcript
            .read(cx)
            .words
            .iter()
            .map(|w| (w.text.clone(), w.start))
            .collect();
        let dsp = self.dsp.clone();

        div()
            .id("transcript-container")
            .w_full()
            .flex_1()
            .bg(rgb(0x1e1e2e))
            .overflow_y_scroll()
            .child(
                uniform_list("transcript-words", word_count, move |range, _window, cx| {
                    range
                        .map(|ix| {
                            let (ref text, start) = words[ix];
                            let is_active = ix == active_idx;
                            let dsp_handle = dsp.clone();

                            div()
                                .id(ix)
                                .px_2()
                                .py(px(2.))
                                .mx(px(2.))
                                .rounded(px(3.))
                                .text_sm()
                                .cursor_pointer()
                                .when(is_active, |el| {
                                    el.bg(rgb(0x45475a)).text_color(rgb(0xf5c2e7))
                                })
                                .when(!is_active, |el| el.text_color(rgb(0xa6adc8)))
                                .on_click(move |_event, _window, cx| {
                                    dsp_handle.update(cx, |state, cx| {
                                        state.playhead_secs = start;
                                        cx.notify();
                                    });
                                })
                                .child(text.clone())
                        })
                        .collect()
                })
                .flex()
                .flex_wrap()
                .p_4(),
            )
    }
}
```

**Step 2: Add module to main.rs**

Add `mod transcript_view;` at the top of `main.rs`.

**Step 3: Verify it compiles**

Run: `cd poc/gpui_timeline && cargo check`
Expected: Compiles with no errors.

**Step 4: Commit**

```bash
git add poc/gpui_timeline/src/transcript_view.rs poc/gpui_timeline/src/main.rs
git commit -m "feat(poc): virtualized transcript view with word highlighting and click-to-seek"
```

---

### Task 6: RootView with Layout, Status Bar, and 60Hz Timer

**Files:**
- Create: `poc/gpui_timeline/src/root_view.rs`
- Modify: `poc/gpui_timeline/src/main.rs` (add `mod root_view;`, rewrite `main()`)

**Step 1: Write root_view.rs**

```rust
use futures::StreamExt;
use gpui::*;
use std::time::Duration;

use crate::data::{generate_transcript, generate_waveform_peaks, DURATION_SECS};
use crate::state::{DspState, PlayheadMoved, TimelineState, TranscriptState};
use crate::transcript_view::TranscriptView;
use crate::waveform_view::WaveformView;

pub struct RootView {
    waveform: Entity<WaveformView>,
    transcript: Entity<TranscriptView>,
    dsp: Entity<DspState>,
    timeline: Entity<TimelineState>,
    _timer_task: Task<()>,
    _subscriptions: Vec<Subscription>,
}

impl RootView {
    pub fn new(cx: &mut Context<Self>) -> Self {
        // Generate mock data
        let peaks = generate_waveform_peaks();
        let words = generate_transcript();

        // Create state entities
        let dsp: Entity<DspState> = cx.new(|_| DspState::new());
        let timeline: Entity<TimelineState> =
            cx.new(|_| TimelineState::new(peaks, DURATION_SECS));
        let transcript: Entity<TranscriptState> =
            cx.new(|_| TranscriptState::new(words));

        // Create view entities
        let dsp_c = dsp.clone();
        let tl_c = timeline.clone();
        let waveform = cx.new(|cx| WaveformView::new(dsp_c, tl_c, cx));

        let dsp_c = dsp.clone();
        let ts_c = transcript.clone();
        let transcript_view = cx.new(|cx| TranscriptView::new(dsp_c, ts_c, cx));

        // 60Hz timer: simulate DSP telemetry
        let dsp_weak = dsp.downgrade();
        let timer_task = cx.spawn(|_this, mut cx| async move {
            let mut interval = Timer::interval(Duration::from_millis(16));
            while let Some(_) = interval.next().await {
                let result = dsp_weak.update(&mut cx, |state, cx| {
                    if state.is_playing {
                        state.playhead_secs += 1.0 / 60.0;
                        if state.playhead_secs > DURATION_SECS {
                            state.playhead_secs = 0.0;
                        }
                        // Simulate LUFS variation
                        state.lufs_momentary =
                            -23.0 + 6.0 * (state.playhead_secs * 0.5).sin() as f32;
                        state.lufs_short_term =
                            -23.0 + 3.0 * (state.playhead_secs * 0.1).sin() as f32;

                        cx.emit(PlayheadMoved {
                            playhead_secs: state.playhead_secs,
                        });
                        cx.notify();
                    }
                });
                if result.is_err() {
                    break;
                }
            }
        });

        // Observe timeline for scroll clamping
        let tl_sub = cx.observe(&timeline, |_this, _entity, cx| cx.notify());

        Self {
            waveform,
            transcript: transcript_view,
            dsp,
            timeline,
            _timer_task: timer_task,
            _subscriptions: vec![tl_sub],
        }
    }
}

impl Render for RootView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let playhead = self.dsp.read(cx).playhead_secs;
        let is_playing = self.dsp.read(cx).is_playing;
        let lufs_m = self.dsp.read(cx).lufs_momentary;
        let frame_us = self.waveform.read(cx).last_frame_time_us;

        let minutes = (playhead / 60.0) as u32;
        let seconds = playhead % 60.0;

        let dsp = self.dsp.clone();
        let timeline = self.timeline.clone();

        div()
            .id("root")
            .flex()
            .flex_col()
            .size_full()
            .bg(rgb(0x11111b))
            .on_key_down(move |event: &KeyDownEvent, _window, cx| {
                if event.keystroke.key == " " {
                    dsp.update(cx, |state, cx| {
                        state.is_playing = !state.is_playing;
                        cx.notify();
                    });
                }
            })
            .on_scroll_wheel(move |event: &ScrollWheelEvent, _window, cx| {
                timeline.update(cx, |state, cx| {
                    if event.modifiers.platform {
                        // Cmd/Ctrl + scroll = zoom
                        let factor = if event.delta.pixel_delta().y.0 > 0.0 {
                            1.2
                        } else {
                            1.0 / 1.2
                        };
                        state.zoom = (state.zoom * factor).clamp(0.5, 500.0);
                    } else {
                        // Scroll = pan
                        let delta_secs = -event.delta.pixel_delta().y.0 as f64 / state.zoom;
                        state.scroll_offset += delta_secs;
                    }
                    state.clamp_scroll(1200.0);
                    cx.notify();
                });
            })
            // Waveform (top)
            .child(&self.waveform)
            // Transcript (bottom, fills remaining space)
            .child(&self.transcript)
            // Status bar
            .child(
                div()
                    .id("status-bar")
                    .w_full()
                    .h(px(32.))
                    .bg(rgb(0x181825))
                    .border_t_1()
                    .border_color(rgb(0x313244))
                    .flex()
                    .items_center()
                    .justify_between()
                    .px_4()
                    .text_xs()
                    .text_color(rgb(0x6c7086))
                    .child(format!(
                        "{}  {:02}:{:05.2}",
                        if is_playing { "▶" } else { "⏸" },
                        minutes,
                        seconds,
                    ))
                    .child(format!("LUFS: {:.1} dB", lufs_m))
                    .child(format!(
                        "Frame: {:.2}ms ({}Hz)",
                        frame_us as f64 / 1000.0,
                        if frame_us > 0 {
                            1_000_000 / frame_us
                        } else {
                            0
                        }
                    )),
            )
    }
}
```

**Step 2: Rewrite main.rs**

```rust
mod data;
mod root_view;
mod state;
mod transcript_view;
mod waveform_view;

use gpui::*;
use root_view::RootView;

fn main() {
    Application::new().run(|cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(1200.), px(800.)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                ..Default::default()
            },
            |_window, cx| cx.new(|cx| RootView::new(cx)),
        )
        .unwrap();
        cx.activate(true);
    });
}
```

**Step 3: Build and run**

Run: `cd poc/gpui_timeline && cargo run`
Expected: Window with waveform on top, transcript words below, status bar at bottom. Press Space to play — playhead line should animate across waveform, active word highlights in transcript.

**Step 4: Commit**

```bash
git add poc/gpui_timeline/src/
git commit -m "feat(poc): root view with 60Hz timer, layout, scroll/zoom, space-to-play"
```

---

### Task 7: Integration Testing and Performance Verification

**Step 1: Run the binary and visually verify**

Run: `cd poc/gpui_timeline && cargo run --release`

Check:
- [ ] Window opens at 1200×800
- [ ] Waveform renders with blue peaks
- [ ] Space toggles play/pause
- [ ] Playhead (red vertical line) animates smoothly at 60FPS
- [ ] Active word highlights in transcript
- [ ] Clicking a word seeks the playhead
- [ ] Scroll wheel pans the waveform
- [ ] Cmd/Ctrl + scroll zooms
- [ ] Status bar shows frame time < 16.6ms
- [ ] No visible stutter or jank

**Step 2: Profile resource usage**

Run (in a second terminal while the app is running):
```bash
# macOS:
# ps aux | grep gpui_timeline

# Linux:
ps -o pid,rss,pcpu,comm -p $(pgrep gpui_timeline)
```

Expected: RSS < 100MB, CPU < 5% idle / < 30% during playback.

**Step 3: Commit final state**

```bash
git add -A poc/gpui_timeline/
git commit -m "feat(poc): gpui timeline PoC complete — 60Hz telemetry, waveform, transcript"
```

---

### Task 8: Fix Compilation Errors and API Mismatches

This is a buffer task. GPUI v0.2.2 API may differ slightly from the documented examples. Expected issues:

- `Edges::default()` may not exist — try `Edges::all(px(0.))` or `edges(px(0.))`
- `BorderStyle::default()` may need `BorderStyle::Solid` or similar
- `uniform_list` method chaining (`.flex()`, `.flex_wrap()`) may not be available on `UniformList`
- `on_scroll_wheel` / `on_key_down` callback signatures may differ
- `ScrollWheelEvent.delta.pixel_delta()` accessor may be different
- `event.modifiers.platform` may be `event.modifiers.command`

When each error surfaces, read the docs.rs page for the specific type and fix the call. This task runs in parallel with tasks 4-6 during the initial `cargo check` cycles.
