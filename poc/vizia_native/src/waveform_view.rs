use std::cell::RefCell;
use vizia::prelude::*;
use vizia::vg::{Color, Paint, PaintStyle, Path};

const PEAK_CHUNK: usize = 256;

#[derive(Clone, Copy, Default)]
pub struct Peak {
    pub min: f32,
    pub max: f32,
}

/// Integer viewport key — avoids float NaN/equality issues.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CacheKey {
    pub width:  u32,   // canvas width in pixels
    pub scroll: u32,   // scroll_offset * 100
    pub zoom:   u32,   // zoom * 1000
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

struct CachedPath {
    key:  CacheKey,
    path: Path,
}

pub struct WaveformView {
    pub peaks:         Vec<Peak>,
    pub scroll_offset: f32,
    pub zoom:          f32,
    path_cache:        RefCell<Option<CachedPath>>,
}

impl WaveformView {
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

    /// Insert into the Vizia tree and return a Handle, consuming `samples`.
    pub fn insert(cx: &mut Context, samples: Vec<f32>) -> Handle<'_, Self> {
        Self::new(samples).build(cx, |_| {})
    }

    /// LOD + viewport culling. Returns at most `canvas_width` peaks covering the visible range.
    ///
    /// - `scroll_offset`: first visible peak index (float, in peak-table units)
    /// - `zoom`: canvas pixels per peak (zoom > 1 = zoomed in, < 1 = zoomed out)
    /// - `canvas_width`: number of pixels (= max peaks to return)
    pub fn visible_peaks(&self, scroll_offset: f32, zoom: f32, canvas_width: usize) -> Vec<Peak> {
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

impl View for WaveformView {
    fn draw(&self, cx: &mut DrawContext, canvas: &Canvas) {
        let b = cx.bounds();
        let new_key = CacheKey::from_viewport(b.w, self.scroll_offset, self.zoom);

        let mut cache = self.path_cache.borrow_mut();
        let rebuild = cache.as_ref().map_or(true, |c| c.key != new_key);

        if rebuild {
            let peaks = self.visible_peaks(self.scroll_offset, self.zoom, b.w as usize);
            let mut path = Path::new();
            let mid_y = b.y + b.h / 2.0;
            let x_step = if peaks.is_empty() { 1.0 } else { b.w / peaks.len() as f32 };

            for (i, peak) in peaks.iter().enumerate() {
                let x = b.x + i as f32 * x_step;
                path.move_to((x, mid_y - peak.max.abs() * b.h * 0.45));
                path.line_to((x, mid_y));
                path.line_to((x, mid_y + peak.min.abs() * b.h * 0.45));
            }

            *cache = Some(CachedPath { key: new_key, path });
        }

        let Some(c) = cache.as_ref() else { return };

        let mut paint = Paint::default();
        paint.set_style(PaintStyle::Stroke);
        paint.set_color(Color::from_rgb(137, 180, 250));
        paint.set_stroke_width(1.0);
        canvas.draw_path(&c.path, &paint);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_view(n_samples: usize) -> WaveformView {
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
    fn lod_returns_fewer_peaks_when_zoomed_in() {
        let view = make_view(44100 * 60);
        // zoom=2.0 → 2px per peak → need canvas_width/2 peaks
        let visible = view.visible_peaks(0.0, 2.0, 800);
        assert_eq!(visible.len(), 400);
    }

    #[test]
    fn lod_clamps_to_available_peaks() {
        let view = make_view(1024);
        // Request more pixels than peaks → returns all peaks
        let visible = view.visible_peaks(0.0, 1.0, 10_000);
        assert_eq!(visible.len(), view.peaks.len());
    }

    #[test]
    fn path_cache_not_rebuilt_on_identical_viewport() {
        // Test CacheKey equality without running GPU draw.
        let key1 = CacheKey { width: 800, scroll: 0, zoom: 1000 };
        let key2 = CacheKey { width: 800, scroll: 0, zoom: 1000 };
        let key3 = CacheKey { width: 800, scroll: 1, zoom: 1000 };
        assert_eq!(key1, key2, "same key must match");
        assert_ne!(key1, key3, "different scroll must not match");
    }
}
