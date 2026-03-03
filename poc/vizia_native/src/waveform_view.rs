use std::cell::RefCell;

const PEAK_CHUNK: usize = 256;

#[derive(Clone, Copy, Default)]
pub struct Peak {
    pub min: f32,
    pub max: f32,
}

pub struct WaveformView {
    pub peaks:         Vec<Peak>,
    pub scroll_offset: f32,
    pub zoom:          f32,
    path_cache:        RefCell<Option<()>>,  // placeholder; replaced in Task 6
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

        let peaks_per_pixel = (1.0 / zoom).max(1.0);
        let start_peak = (scroll_offset as usize).min(total);
        let end_peak = ((scroll_offset + peaks_per_pixel * canvas_width as f32)
            .ceil() as usize)
            .min(total);

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
    fn lod_clamps_to_available_peaks() {
        let view = make_view(1024);
        // Request more pixels than peaks → returns all peaks
        let visible = view.visible_peaks(0.0, 1.0, 10_000);
        assert_eq!(visible.len(), view.peaks.len());
    }
}
