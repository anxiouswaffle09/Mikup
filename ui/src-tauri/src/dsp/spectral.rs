use std::sync::Arc;

use rustfft::num_complex::Complex32;
use rustfft::{Fft, FftPlanner};

use crate::dsp::SyncedAudioFrame;

const EPSILON: f32 = 1.0e-12;
const SPEECH_LOW_HZ: f32 = 1_000.0;
const SPEECH_HIGH_HZ: f32 = 4_000.0;

#[derive(Debug, Clone, Copy, Default)]
pub struct SpectralMetrics {
    pub dialogue_centroid_hz: f32,
    pub background_centroid_hz: f32,
    pub speech_pocket_masked: bool,
    pub dialogue_speech_energy: f32,
    pub background_speech_energy: f32,
    pub snr_db: f32,
}

pub struct SpectralAnalyzer {
    sample_rate: u32,
    frame_size: usize,
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    dialogue_buffer: Vec<Complex32>,
    background_buffer: Vec<Complex32>,
}

impl SpectralAnalyzer {
    pub fn new(sample_rate: u32, frame_size: usize) -> Self {
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(frame_size);
        let window = hann_window(frame_size);
        let dialogue_buffer = vec![Complex32::new(0.0, 0.0); frame_size];
        let background_buffer = vec![Complex32::new(0.0, 0.0); frame_size];

        Self {
            sample_rate,
            frame_size,
            fft,
            window,
            dialogue_buffer,
            background_buffer,
        }
    }

    pub fn process_frame(&mut self, frame: &SyncedAudioFrame) -> SpectralMetrics {
        if frame.sample_rate != self.sample_rate || self.frame_size == 0 {
            return SpectralMetrics::default();
        }

        fill_fft_buffer(&mut self.dialogue_buffer, &frame.dialogue_raw, &self.window);
        fill_fft_buffer(
            &mut self.background_buffer,
            &frame.background_raw,
            &self.window,
        );

        self.fft.process(&mut self.dialogue_buffer);
        self.fft.process(&mut self.background_buffer);

        let dialogue_magnitudes = magnitudes(&self.dialogue_buffer);
        let background_magnitudes = magnitudes(&self.background_buffer);

        let dialogue_centroid_hz = spectral_centroid_hz(&dialogue_magnitudes, self.sample_rate);
        let background_centroid_hz = spectral_centroid_hz(&background_magnitudes, self.sample_rate);
        let dialogue_speech_energy = speech_band_energy(
            &dialogue_magnitudes,
            self.sample_rate,
            SPEECH_LOW_HZ,
            SPEECH_HIGH_HZ,
        );
        let background_speech_energy = speech_band_energy(
            &background_magnitudes,
            self.sample_rate,
            SPEECH_LOW_HZ,
            SPEECH_HIGH_HZ,
        );
        let snr_db = signal_to_noise_ratio_db(&frame.dialogue_raw, &frame.background_raw);

        SpectralMetrics {
            dialogue_centroid_hz,
            background_centroid_hz,
            speech_pocket_masked: background_speech_energy > dialogue_speech_energy,
            dialogue_speech_energy,
            background_speech_energy,
            snr_db,
        }
    }
}

fn hann_window(frame_size: usize) -> Vec<f32> {
    if frame_size <= 1 {
        return vec![1.0; frame_size];
    }

    let denom = (frame_size - 1) as f32;
    (0..frame_size)
        .map(|i| 0.5 - 0.5 * ((2.0 * std::f32::consts::PI * i as f32) / denom).cos())
        .collect()
}

fn fill_fft_buffer(buffer: &mut [Complex32], input: &[f32], window: &[f32]) {
    for (i, sample) in buffer.iter_mut().enumerate() {
        let v = input.get(i).copied().unwrap_or(0.0);
        sample.re = v * window[i];
        sample.im = 0.0;
    }
}

fn magnitudes(spectrum: &[Complex32]) -> Vec<f32> {
    let nyquist_bins = spectrum.len() / 2 + 1;
    spectrum
        .iter()
        .take(nyquist_bins)
        .map(|c| c.norm())
        .collect()
}

fn spectral_centroid_hz(magnitudes: &[f32], sample_rate: u32) -> f32 {
    if magnitudes.is_empty() {
        return 0.0;
    }

    let fft_size = (magnitudes.len().saturating_sub(1) * 2).max(1);
    let hz_per_bin = sample_rate as f32 / fft_size as f32;

    let mut weighted_sum = 0.0_f32;
    let mut amplitude_sum = 0.0_f32;

    for (bin, &amp) in magnitudes.iter().enumerate() {
        let frequency = bin as f32 * hz_per_bin;
        weighted_sum += frequency * amp;
        amplitude_sum += amp;
    }

    if amplitude_sum <= EPSILON {
        0.0
    } else {
        weighted_sum / amplitude_sum
    }
}

fn speech_band_energy(magnitudes: &[f32], sample_rate: u32, low_hz: f32, high_hz: f32) -> f32 {
    if magnitudes.is_empty() || low_hz >= high_hz {
        return 0.0;
    }

    let fft_size = (magnitudes.len().saturating_sub(1) * 2).max(1);
    let hz_per_bin = sample_rate as f32 / fft_size as f32;
    if hz_per_bin <= EPSILON {
        return 0.0;
    }

    let mut start = (low_hz / hz_per_bin).floor() as usize;
    let mut end = (high_hz / hz_per_bin).ceil() as usize;
    if start >= magnitudes.len() {
        start = magnitudes.len().saturating_sub(1);
    }
    if end >= magnitudes.len() {
        end = magnitudes.len().saturating_sub(1);
    }
    if end < start {
        return 0.0;
    }

    magnitudes[start..=end]
        .iter()
        .copied()
        .map(|m| m * m)
        .sum::<f32>()
}

fn signal_to_noise_ratio_db(dialogue: &[f32], background: &[f32]) -> f32 {
    let len = dialogue.len().min(background.len());
    if len == 0 {
        return 0.0;
    }

    let dialogue_power = dialogue[..len].iter().copied().map(|x| x * x).sum::<f32>() / len as f32;
    let background_power = background[..len]
        .iter()
        .copied()
        .map(|x| x * x)
        .sum::<f32>()
        / len as f32;
    let ratio = (dialogue_power + EPSILON) / (background_power + EPSILON);
    (10.0 * ratio.log10()).clamp(-20.0, 60.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn centroid_tracks_frequency_position() {
        let sample_rate = 48_000;
        let frame_size = 2048;
        let mut analyzer = SpectralAnalyzer::new(sample_rate, frame_size);

        let tone_hz = 2_000.0_f32;
        let dialogue: Vec<f32> = (0..frame_size)
            .map(|i| ((2.0 * std::f32::consts::PI * tone_hz * i as f32) / sample_rate as f32).sin())
            .collect();
        let frame = SyncedAudioFrame {
            sample_rate,
            dialogue_raw: dialogue,
            background_raw: vec![0.0; frame_size],
            ..SyncedAudioFrame::default()
        };

        let metrics = analyzer.process_frame(&frame);
        assert!((metrics.dialogue_centroid_hz - tone_hz).abs() < 250.0);
    }
}
