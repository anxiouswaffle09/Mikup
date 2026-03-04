use crate::dsp::SyncedAudioFrame;

const SQRT_HALF: f32 = 0.70710677;
const EPSILON: f32 = 1.0e-12;

#[derive(Debug, Clone, Copy, Default)]
pub struct LissajousPoint {
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SpatialMetrics {
    pub phase_correlation: f32,
}

#[derive(Debug)]
pub struct SpatialAnalyzer {
    lissajous_buffer: Vec<LissajousPoint>,
}

impl SpatialAnalyzer {
    pub fn new() -> Self {
        Self {
            lissajous_buffer: Vec::new(),
        }
    }

    pub fn process_frame(&mut self, frame: &SyncedAudioFrame) -> SpatialMetrics {
        let len = frame.len();
        if len == 0 {
            self.lissajous_buffer.clear();
            return SpatialMetrics::default();
        }

        let dialogue = &frame.dialogue_raw[..len];
        let background = &frame.background_raw[..len];

        lissajous_points_into(dialogue, background, &mut self.lissajous_buffer);

        SpatialMetrics {
            phase_correlation: pearson_correlation(dialogue, background),
        }
    }

    /// Access the Lissajous points computed by the last `process_frame` call.
    /// Buffer is reused across frames — zero allocations after warm-up.
    pub fn lissajous_points(&self) -> &[LissajousPoint] {
        &self.lissajous_buffer
    }
}

fn pearson_correlation(left: &[f32], right: &[f32]) -> f32 {
    if left.len() != right.len() || left.is_empty() {
        return 0.0;
    }

    let n = left.len() as f32;
    let mean_left = left.iter().copied().sum::<f32>() / n;
    let mean_right = right.iter().copied().sum::<f32>() / n;

    let mut covariance = 0.0_f32;
    let mut variance_left = 0.0_f32;
    let mut variance_right = 0.0_f32;

    for (&l, &r) in left.iter().zip(right.iter()) {
        let dl = l - mean_left;
        let dr = r - mean_right;
        covariance += dl * dr;
        variance_left += dl * dl;
        variance_right += dr * dr;
    }

    let denom = (variance_left * variance_right).sqrt();
    if denom <= EPSILON {
        0.0
    } else {
        (covariance / denom).clamp(-1.0, 1.0)
    }
}

fn lissajous_points_into(left: &[f32], right: &[f32], out: &mut Vec<LissajousPoint>) {
    out.clear();
    out.reserve(left.len().min(right.len()).saturating_sub(out.capacity()));
    for (&l, &r) in left.iter().zip(right.iter()) {
        out.push(LissajousPoint {
            x: (l - r) * SQRT_HALF,
            y: (l + r) * SQRT_HALF,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn correlation_is_positive_for_matching_signals() {
        let a = vec![0.1, 0.2, 0.3, 0.4];
        let b = a.clone();
        let corr = pearson_correlation(&a, &b);
        assert!((corr - 1.0).abs() < 1.0e-4);
    }

    #[test]
    fn lissajous_mapping_matches_expected_transform() {
        let mut buf = Vec::new();
        lissajous_points_into(&[1.0], &[-1.0], &mut buf);
        assert_eq!(buf.len(), 1);
        assert!((buf[0].x - (2.0 * SQRT_HALF)).abs() < 1.0e-6);
        assert!(buf[0].y.abs() < 1.0e-6);
    }
}
