#![allow(dead_code)]

use ebur128::{EbuR128, Mode};

use crate::dsp::SyncedAudioFrame;

const LUFS_FLOOR: f32 = -70.0;
const LUFS_CEILING: f32 = 0.0;
const TRUE_PEAK_SILENCE_DBTP: f32 = -120.0;
const EPSILON: f32 = 1.0e-12;
const ENVELOPE_ATTACK_MS: f32 = 5.0;
const ENVELOPE_RELEASE_MS: f32 = 150.0;

#[derive(Debug, Clone, Copy, Default)]
pub struct StemFinalMetrics {
    pub integrated_lufs: f32,
    pub loudness_range_lu: f32,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct FinalLoudnessMetrics {
    pub dialogue: StemFinalMetrics,
    pub music: StemFinalMetrics,
    pub effects: StemFinalMetrics,
}

#[derive(Debug)]
pub enum LoudnessError {
    InvalidSampleRate(u32),
    Meter(ebur128::Error),
}

impl std::fmt::Display for LoudnessError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidSampleRate(rate) => {
                write!(f, "invalid sample rate for loudness analyzer: {rate}")
            }
            Self::Meter(err) => write!(f, "ebur128 loudness error: {err}"),
        }
    }
}

impl std::error::Error for LoudnessError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Meter(err) => Some(err),
            _ => None,
        }
    }
}

impl From<ebur128::Error> for LoudnessError {
    fn from(value: ebur128::Error) -> Self {
        Self::Meter(value)
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct StemLoudnessMetrics {
    pub momentary_lufs: f32,
    pub short_term_lufs: f32,
    pub true_peak_dbtp: f32,
    pub crest_factor: f32,
    pub transient_density: f32,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct LoudnessMetrics {
    pub master: StemLoudnessMetrics,
}

#[derive(Debug)]
pub struct LoudnessAnalyzer {
    sample_rate: u32,
    dialogue_meter: EbuR128,
    music_meter: EbuR128,
    effects_meter: EbuR128,
}

#[derive(Debug)]
pub struct MasterLoudnessAnalyzer {
    sample_rate: u32,
    master_meter: EbuR128,
    master_envelope: EnvelopeFollower,
    master_buffer: Vec<f32>,
}

impl LoudnessAnalyzer {
    pub fn new(sample_rate: u32) -> Result<Self, LoudnessError> {
        if sample_rate == 0 {
            return Err(LoudnessError::InvalidSampleRate(sample_rate));
        }

        let mode = Mode::M | Mode::S | Mode::I | Mode::LRA;
        let dialogue_meter = EbuR128::new(1, sample_rate, mode)?;
        let music_meter = EbuR128::new(1, sample_rate, mode)?;
        let effects_meter = EbuR128::new(1, sample_rate, mode)?;

        Ok(Self {
            sample_rate,
            dialogue_meter,
            music_meter,
            effects_meter,
        })
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn reset(&mut self) {
        self.dialogue_meter.reset();
        self.music_meter.reset();
        self.effects_meter.reset();
    }

    pub fn final_metrics(&self) -> FinalLoudnessMetrics {
        FinalLoudnessMetrics {
            dialogue: StemFinalMetrics {
                integrated_lufs: read_lufs(self.dialogue_meter.loudness_global()),
                loudness_range_lu: read_lu(self.dialogue_meter.loudness_range()),
            },
            music: StemFinalMetrics {
                integrated_lufs: read_lufs(self.music_meter.loudness_global()),
                loudness_range_lu: read_lu(self.music_meter.loudness_range()),
            },
            effects: StemFinalMetrics {
                integrated_lufs: read_lufs(self.effects_meter.loudness_global()),
                loudness_range_lu: read_lu(self.effects_meter.loudness_range()),
            },
        }
    }

    pub fn process_frame(&mut self, frame: &SyncedAudioFrame) -> Result<(), LoudnessError> {
        if frame.sample_rate != self.sample_rate {
            return Err(LoudnessError::InvalidSampleRate(frame.sample_rate));
        }

        self.dialogue_meter.add_frames_f32(&frame.dialogue_raw)?;
        self.music_meter.add_frames_f32(&frame.music_raw)?;
        self.effects_meter.add_frames_f32(&frame.effects_raw)?;

        Ok(())
    }
}

impl MasterLoudnessAnalyzer {
    pub fn new(sample_rate: u32) -> Result<Self, LoudnessError> {
        if sample_rate == 0 {
            return Err(LoudnessError::InvalidSampleRate(sample_rate));
        }

        let mode = Mode::M | Mode::S | Mode::I | Mode::LRA;
        let master_meter = EbuR128::new(1, sample_rate, mode)?;
        let master_envelope =
            EnvelopeFollower::new(sample_rate, ENVELOPE_ATTACK_MS, ENVELOPE_RELEASE_MS);

        Ok(Self {
            sample_rate,
            master_meter,
            master_envelope,
            master_buffer: Vec::with_capacity(2048),
        })
    }

    pub fn reset(&mut self) {
        self.master_meter.reset();
        self.master_envelope.reset();
        self.master_buffer.clear();
    }

    pub fn process_frame(
        &mut self,
        frame: &SyncedAudioFrame,
    ) -> Result<LoudnessMetrics, LoudnessError> {
        if frame.sample_rate != self.sample_rate {
            return Err(LoudnessError::InvalidSampleRate(frame.sample_rate));
        }

        let master_len = frame.dialogue_raw.len().max(frame.background_raw.len());
        debug_assert!(master_len <= self.master_buffer.capacity());

        self.master_buffer.clear();
        for index in 0..master_len {
            let dialogue = frame.dialogue_raw.get(index).copied().unwrap_or(0.0);
            let background = frame.background_raw.get(index).copied().unwrap_or(0.0);
            self.master_buffer.push(dialogue + background);
        }

        self.master_meter.add_frames_f32(&self.master_buffer)?;

        Ok(LoudnessMetrics {
            master: StemLoudnessMetrics {
                momentary_lufs: read_lufs(self.master_meter.loudness_momentary()),
                short_term_lufs: read_lufs(self.master_meter.loudness_shortterm()),
                true_peak_dbtp: true_peak_dbtp_4x_cubic(&self.master_buffer),
                crest_factor: crest_factor(&self.master_buffer),
                transient_density: transient_density(
                    &self.master_buffer,
                    &mut self.master_envelope,
                ),
            },
        })
    }
}

#[derive(Debug, Clone, Copy)]
struct EnvelopeFollower {
    level: f32,
    attack_coeff: f32,
    release_coeff: f32,
}

impl EnvelopeFollower {
    fn new(sample_rate: u32, attack_ms: f32, release_ms: f32) -> Self {
        Self {
            level: 0.0,
            attack_coeff: smoothing_coefficient(sample_rate, attack_ms),
            release_coeff: smoothing_coefficient(sample_rate, release_ms),
        }
    }

    fn reset(&mut self) {
        self.level = 0.0;
    }

    fn process(&mut self, input: f32) -> f32 {
        let magnitude = input.abs();
        let coeff = if magnitude > self.level {
            self.attack_coeff
        } else {
            self.release_coeff
        };
        self.level = coeff * self.level + (1.0 - coeff) * magnitude;
        self.level
    }
}

fn read_lu(value: Result<f64, ebur128::Error>) -> f32 {
    match value {
        Ok(v) if v.is_finite() && v >= 0.0 => v as f32,
        _ => 0.0,
    }
}

fn read_lufs(value: Result<f64, ebur128::Error>) -> f32 {
    match value {
        Ok(lufs) if lufs.is_finite() => (lufs as f32).clamp(LUFS_FLOOR, LUFS_CEILING),
        _ => LUFS_FLOOR,
    }
}

fn crest_factor(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }

    let peak = samples
        .iter()
        .copied()
        .map(f32::abs)
        .fold(0.0_f32, |max_v, v| max_v.max(v));

    if peak <= 0.0 {
        return 0.0;
    }

    let mean_square = samples.iter().copied().map(|x| x * x).sum::<f32>() / samples.len() as f32;
    let rms = mean_square.sqrt();

    if rms <= EPSILON {
        0.0
    } else {
        peak / rms
    }
}

fn smoothing_coefficient(sample_rate: u32, time_ms: f32) -> f32 {
    if sample_rate == 0 || time_ms <= 0.0 {
        return 0.0;
    }

    let tau_seconds = time_ms / 1000.0;
    (-1.0 / (tau_seconds * sample_rate as f32)).exp()
}

fn transient_density(samples: &[f32], follower: &mut EnvelopeFollower) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }

    let mut peak = 0.0_f32;
    let mut envelope_sum = 0.0_f32;
    for &sample in samples {
        let magnitude = sample.abs();
        peak = peak.max(magnitude);
        envelope_sum += follower.process(magnitude);
    }

    if peak <= EPSILON {
        return 0.0;
    }

    let average_envelope = envelope_sum / samples.len() as f32;
    if average_envelope <= EPSILON {
        0.0
    } else {
        peak / average_envelope
    }
}

#[inline]
fn cubic_interp(p: [f32; 4], t: f32) -> f32 {
    let a = -0.5 * p[0] + 1.5 * p[1] - 1.5 * p[2] + 0.5 * p[3];
    let b = p[0] - 2.5 * p[1] + 2.0 * p[2] - 0.5 * p[3];
    let c = -0.5 * p[0] + 0.5 * p[2];
    let d = p[1];
    ((a * t + b) * t + c) * t + d
}

fn true_peak_dbtp_4x_cubic(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return TRUE_PEAK_SILENCE_DBTP;
    }

    let n = samples.len();
    let mut max_abs = 0.0_f32;
    for &s in samples {
        max_abs = max_abs.max(s.abs());
    }

    if n >= 2 {
        for i in 0..n - 1 {
            let p0 = if i > 0 { samples[i - 1] } else { samples[0] };
            let p1 = samples[i];
            let p2 = samples[i + 1];
            let p3 = if i + 2 < n {
                samples[i + 2]
            } else {
                samples[n - 1]
            };

            for &t in &[0.25_f32, 0.5, 0.75] {
                max_abs = max_abs.max(cubic_interp([p0, p1, p2, p3], t).abs());
            }
        }
    }

    if max_abs <= EPSILON {
        TRUE_PEAK_SILENCE_DBTP
    } else {
        20.0 * max_abs.log10()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crest_factor_of_sine_is_about_sqrt2() {
        let samples: Vec<f32> = (0..2048)
            .map(|i| ((i as f32) * 2.0 * std::f32::consts::PI / 64.0).sin())
            .collect();
        let cf = crest_factor(&samples);
        assert!((cf - std::f32::consts::SQRT_2).abs() < 0.05);
    }

    #[test]
    fn true_peak_handles_silence() {
        let dbtp = true_peak_dbtp_4x_cubic(&[0.0; 128]);
        assert_eq!(dbtp, TRUE_PEAK_SILENCE_DBTP);
    }

    #[test]
    fn transient_density_highlights_sparse_impulses() {
        let mut follower = EnvelopeFollower::new(48_000, ENVELOPE_ATTACK_MS, ENVELOPE_RELEASE_MS);
        let bed = vec![0.2; 2048];
        let steady = transient_density(&bed, &mut follower);

        let mut sting = vec![0.2; 2048];
        sting[1024] = 1.0;
        let accented = transient_density(&sting, &mut follower);

        assert!(steady > 0.9);
        assert!(accented > steady * 1.5);
    }
}
