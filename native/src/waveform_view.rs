use std::cell::RefCell;
use std::sync::Arc;

use vizia::prelude::*;
use vizia::vg::{Color, Paint, PaintStyle, Path};

use crate::dsp::scanner::WaveformPeak;
use crate::models::{AppData, AppEvent, AudioEngineStore, AudioEngineStoreUpdate};

const WAVEFORM_SCALE: f32 = 0.45;

/// Integer viewport key — avoids float NaN/equality issues.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CacheKey {
    pub width: u32,  // canvas width in pixels
    pub scroll: u32, // scroll_offset * 100
    pub zoom: u32,   // zoom * 1000
}

impl CacheKey {
    fn from_viewport(width: f32, scroll: f32, zoom: f32) -> Self {
        Self {
            width: width as u32,
            scroll: (scroll * 100.0) as u32,
            zoom: (zoom * 1000.0) as u32,
        }
    }
}

struct CachedPath {
    key: CacheKey,
    path: Path,
}

pub struct WaveformView {
    pub peaks: Vec<WaveformPeak>,
    pub total_duration_ms: u64,
    pub scroll_offset: f32,
    pub zoom: f32,
    pub scrub_anchor_x: f32,
    pub scrub_anchor_ts_ms: u64,
    path_cache: RefCell<Option<CachedPath>>,
}

impl WaveformView {
    #[cfg(test)]
    pub fn new(samples: &[f32]) -> Self {
        const PEAK_CHUNK: usize = 256;
        let n_peaks = samples.len().div_ceil(PEAK_CHUNK);
        let mut peaks = vec![WaveformPeak::default(); n_peaks];
        for (chunk_idx, chunk) in samples.chunks(PEAK_CHUNK).enumerate() {
            let min = chunk.iter().copied().fold(f32::INFINITY, f32::min);
            let max = chunk.iter().copied().fold(f32::NEG_INFINITY, f32::max);
            peaks[chunk_idx] = WaveformPeak { min, max };
        }
        Self::from_peaks(&peaks, 0)
    }

    pub fn from_peaks(peaks: &[WaveformPeak], total_duration_ms: u64) -> Self {
        Self {
            peaks: peaks.to_vec(),
            total_duration_ms,
            scroll_offset: 0.0,
            zoom: 1.0,
            scrub_anchor_x: 0.0,
            scrub_anchor_ts_ms: 0,
            path_cache: RefCell::new(None),
        }
    }

    /// Insert into the Vizia tree and return a Handle.
    /// Accepts `Arc<Vec<WaveformPeak>>` to avoid a deep copy at the call site.
    pub fn insert(
        cx: &mut Context,
        peaks: Arc<Vec<WaveformPeak>>,
        total_duration_ms: u64,
    ) -> Handle<'_, Self> {
        Self::from_peaks(peaks.as_slice(), total_duration_ms).build(cx, |_| {})
    }

    fn timestamp_to_x(&self, bounds: &BoundingBox, ts_ms: u64) -> f32 {
        if self.total_duration_ms == 0 {
            return bounds.x;
        }

        let t = ts_ms as f32 / self.total_duration_ms as f32;
        bounds.x + t * bounds.w
    }

    fn clamp_timestamp_ms(&self, ts_ms: f32) -> u64 {
        ts_ms.clamp(0.0, self.total_duration_ms as f32).round() as u64
    }

    fn absolute_timestamp_ms(&self, bounds: &BoundingBox, x: f32) -> u64 {
        if self.total_duration_ms == 0 || bounds.w <= 0.0 {
            return 0;
        }

        let rel_x = ((x - bounds.x) / bounds.w).clamp(0.0, 1.0);
        self.clamp_timestamp_ms(rel_x * self.total_duration_ms as f32)
    }

    fn scrub_timestamp_ms(&self, bounds: &BoundingBox, x: f32, sensitivity: f32) -> u64 {
        if self.total_duration_ms == 0 || bounds.w <= 0.0 {
            return 0;
        }

        if (sensitivity - 1.0).abs() <= f32::EPSILON {
            return self.absolute_timestamp_ms(bounds, x);
        }

        let delta_ms =
            ((x - self.scrub_anchor_x) / bounds.w) * self.total_duration_ms as f32 * sensitivity;
        self.clamp_timestamp_ms(self.scrub_anchor_ts_ms as f32 + delta_ms)
    }

    /// LOD + viewport culling. Returns at most `canvas_width` peaks covering the visible range.
    ///
    /// - `scroll_offset`: first visible peak index (float, in peak-table units)
    /// - `zoom`: canvas pixels per peak (zoom > 1 = zoomed in, < 1 = zoomed out)
    /// - `canvas_width`: number of pixels (= max peaks to return)
    pub fn visible_peaks(
        &self,
        scroll_offset: f32,
        zoom: f32,
        canvas_width: usize,
    ) -> Vec<WaveformPeak> {
        let total = self.peaks.len();
        if total == 0 || canvas_width == 0 {
            return Vec::new();
        }

        if zoom <= 0.0 {
            return Vec::new();
        }
        // peaks needed to fill canvas = canvas_width / zoom (zoom=pixels per peak)
        let visible_peak_count = (canvas_width as f32 / zoom).ceil() as usize;
        let start_peak = (scroll_offset as usize).min(total);
        let end_peak = (start_peak + visible_peak_count).min(total);

        if start_peak >= end_peak {
            return Vec::new();
        }

        let visible_count = end_peak - start_peak;

        if visible_count <= canvas_width {
            self.peaks[start_peak..end_peak].to_vec()
        } else {
            // Per-pixel addressing distributes all visible_count peaks evenly,
            // avoiding the trailing-data loss of a fixed integer stride.
            let mut out = Vec::with_capacity(canvas_width);
            for px in 0..canvas_width {
                let i0 = start_peak + px * visible_count / canvas_width;
                let i1 = (start_peak + (px + 1) * visible_count / canvas_width).min(total);
                let min = self.peaks[i0..i1]
                    .iter()
                    .map(|p| p.min)
                    .fold(f32::INFINITY, f32::min);
                let max = self.peaks[i0..i1]
                    .iter()
                    .map(|p| p.max)
                    .fold(f32::NEG_INFINITY, f32::max);
                out.push(WaveformPeak { min, max });
            }
            out
        }
    }
}

impl View for WaveformView {
    fn event(&mut self, cx: &mut EventContext, event: &mut Event) {
        event.map(|_update: &AudioEngineStoreUpdate, _meta| {
            cx.needs_redraw();
        });

        event.take(|window_event: WindowEvent, _| match window_event {
            WindowEvent::MouseDown(MouseButton::Left) => {
                let bounds = cx.bounds();
                let x = cx.mouse().cursor_x;
                let ts_ms = self.absolute_timestamp_ms(&bounds, x);

                self.scrub_anchor_x = x;
                self.scrub_anchor_ts_ms = ts_ms;

                cx.capture();
                cx.emit(AppEvent::StartScrubbing);
                cx.emit(AppEvent::SeekTo(ts_ms));
                cx.needs_redraw();
            }
            WindowEvent::MouseMove(x, _) => {
                if AppData::is_scrubbing.get(cx) {
                    let bounds = cx.bounds();
                    let sensitivity = AppData::seek_sensitivity.get(cx).clamp(0.1, 10.0);
                    let ts_ms = self.scrub_timestamp_ms(&bounds, x, sensitivity);
                    cx.emit(AppEvent::SeekTo(ts_ms));
                    cx.needs_redraw();
                }
            }
            WindowEvent::MouseUp(MouseButton::Left) => {
                cx.release();
                cx.emit(AppEvent::StopScrubbing);
                cx.needs_redraw();
            }
            _ => {}
        });
    }

    fn draw(&self, cx: &mut DrawContext, canvas: &Canvas) {
        let b = cx.bounds();
        if b.w <= 0.0 || b.h <= 0.0 {
            return;
        }

        let new_key = CacheKey::from_viewport(b.w, self.scroll_offset, self.zoom);

        let mut cache = self.path_cache.borrow_mut();
        let rebuild = cache.as_ref().map_or(true, |c| c.key != new_key);

        if rebuild {
            let peaks = self.visible_peaks(self.scroll_offset, self.zoom, b.w as usize);
            let mut path = Path::new();
            let mid_y = b.y + b.h / 2.0;
            let x_step = if peaks.is_empty() {
                1.0
            } else {
                b.w / peaks.len() as f32
            };

            for (i, peak) in peaks.iter().enumerate() {
                let x = b.x + i as f32 * x_step;
                path.move_to((x, mid_y - peak.max.abs() * b.h * WAVEFORM_SCALE));
                path.line_to((x, mid_y));
                path.line_to((x, mid_y + peak.min.abs() * b.h * WAVEFORM_SCALE));
            }

            *cache = Some(CachedPath { key: new_key, path });
        }

        let Some(c) = cache.as_ref() else { return };

        let mut paint = Paint::default();
        paint.set_style(PaintStyle::Stroke);
        paint.set_color(Color::from_rgb(137, 180, 250));
        paint.set_stroke_width(1.0);
        canvas.draw_path(&c.path, &paint);

        let playhead_x = self.timestamp_to_x(&b, AudioEngineStore::playhead_ms.get(cx));
        let mut playhead_path = Path::new();
        playhead_path.move_to((playhead_x, b.y));
        playhead_path.line_to((playhead_x, b.y + b.h));

        let mut playhead_paint = Paint::default();
        playhead_paint.set_style(PaintStyle::Stroke);
        playhead_paint.set_color(Color::from_rgb(255, 255, 255));
        playhead_paint.set_stroke_width(1.5);
        playhead_paint.set_anti_alias(true);
        canvas.draw_path(&playhead_path, &playhead_paint);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_view(n_samples: usize) -> WaveformView {
        let samples: Vec<f32> = (0..n_samples)
            .map(|i| (i as f32 / n_samples as f32) * 2.0 - 1.0)
            .collect();
        WaveformView::new(&samples)
    }

    #[test]
    fn peak_table_length_matches_chunks() {
        let view = make_view(44100);
        // Default chunk = 256 samples \u2192 ceil(44100/256) = 173 entries
        assert_eq!(view.peaks.len(), (44100 + 255) / 256);
    }

    #[test]
    fn lod_returns_only_visible_peaks() {
        let view = make_view(44100 * 60); // 1 min audio
        let visible = view.visible_peaks(0.0, 1.0, 800);
        assert_eq!(visible.len(), 800, "should return exactly 1 peak/pixel");
    }

    #[test]
    fn lod_returns_fewer_peaks_when_zoomed_in() {
        let view = make_view(44100 * 60);
        // zoom=2.0 \u2192 2px per peak \u2192 need canvas_width/2 peaks
        let visible = view.visible_peaks(0.0, 2.0, 800);
        assert_eq!(visible.len(), 400);
    }

    #[test]
    fn lod_clamps_to_available_peaks() {
        let view = make_view(1024);
        // Request more pixels than peaks \u2192 returns all peaks
        let visible = view.visible_peaks(0.0, 1.0, 10_000);
        assert_eq!(visible.len(), view.peaks.len());
    }

    #[test]
    fn path_cache_not_rebuilt_on_identical_viewport() {
        // Test CacheKey equality without running GPU draw.
        let key1 = CacheKey {
            width: 800,
            scroll: 0,
            zoom: 1000,
        };
        let key2 = CacheKey {
            width: 800,
            scroll: 0,
            zoom: 1000,
        };
        let key3 = CacheKey {
            width: 800,
            scroll: 1,
            zoom: 1000,
        };
        assert_eq!(key1, key2, "same key must match");
        assert_ne!(key1, key3, "different scroll must not match");
    }
}
