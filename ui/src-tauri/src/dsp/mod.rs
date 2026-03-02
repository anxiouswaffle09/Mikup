pub mod loudness;
pub mod player;
pub mod scanner;
pub mod spatial;
pub mod spectral;

use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use symphonia::core::audio::{AudioBufferRef, SampleBuffer};
use symphonia::core::codecs::{Decoder, DecoderOptions};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;
use symphonia::default::{get_codecs, get_probe};

const DEFAULT_TARGET_SAMPLE_RATE: u32 = 48_000;
const DEFAULT_FRAME_SIZE: usize = 2048;
const STEM_FADE_MS: f32 = 5.0;
const STEM_IDS: [&str; 3] = ["dx", "music", "effects"];

#[derive(Debug)]
pub enum AudioDecodeError {
    MissingStem {
        stem: &'static str,
        path: PathBuf,
    },
    InvalidConfig(&'static str),
    Io(std::io::Error),
    Probe(String),
    UnsupportedFormat {
        stem: &'static str,
        path: PathBuf,
        format: String,
    },
    NoAudioTrack {
        stem: &'static str,
        path: PathBuf,
    },
    MissingSampleRate {
        stem: &'static str,
        path: PathBuf,
    },
    Decode {
        stem: &'static str,
        source: SymphoniaError,
    },
    Seek {
        stem: &'static str,
        seconds: f32,
        source: SymphoniaError,
    },
}

impl std::fmt::Display for AudioDecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingStem { stem, path } => {
                write!(f, "Missing {stem} stem at {}", path.display())
            }
            Self::InvalidConfig(msg) => write!(f, "Invalid decoder configuration: {msg}"),
            Self::Io(err) => write!(f, "I/O error while decoding stems: {err}"),
            Self::Probe(msg) => write!(f, "Unable to probe audio stream: {msg}"),
            Self::UnsupportedFormat { stem, path, format } => write!(
                f,
                "Unsupported format for {stem} stem at {} (detected {format}, expected WAV)",
                path.display()
            ),
            Self::NoAudioTrack { stem, path } => {
                write!(
                    f,
                    "No decodable audio track found in {stem} stem at {}",
                    path.display()
                )
            }
            Self::MissingSampleRate { stem, path } => {
                write!(
                    f,
                    "Missing sample-rate metadata in {stem} stem at {}",
                    path.display()
                )
            }
            Self::Decode { stem, source } => {
                write!(f, "Decode error in {stem} stem: {source}")
            }
            Self::Seek {
                stem,
                seconds,
                source,
            } => {
                write!(f, "Seek error in {stem} stem at {seconds:.3}s: {source}")
            }
        }
    }
}

impl std::error::Error for AudioDecodeError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(err) => Some(err),
            Self::Decode { source, .. } => Some(source),
            Self::Seek { source, .. } => Some(source),
            _ => None,
        }
    }
}

impl From<std::io::Error> for AudioDecodeError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct StemState {
    pub is_solo: bool,
    pub is_muted: bool,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct AudioFrameStemFlags {
    pub dx: StemState,
    pub music: StemState,
    pub effects: StemState,
}

impl AudioFrameStemFlags {
    fn from_map(map: &HashMap<String, StemState>) -> Self {
        Self {
            dx: *map.get("dx").unwrap_or(&StemState::default()),
            music: *map.get("music").unwrap_or(&StemState::default()),
            effects: *map.get("effects").unwrap_or(&StemState::default()),
        }
    }

    fn any_solo(self) -> bool {
        self.dx.is_solo || self.music.is_solo || self.effects.is_solo
    }
}

pub type SharedStemStates = Arc<RwLock<HashMap<String, StemState>>>;

pub fn default_stem_states() -> HashMap<String, StemState> {
    STEM_IDS
        .into_iter()
        .map(|id| (id.to_string(), StemState::default()))
        .collect()
}

pub fn shared_default_stem_states() -> SharedStemStates {
    Arc::new(RwLock::new(default_stem_states()))
}

#[derive(Debug, Clone, Copy)]
struct StemRuntimeGains {
    dx: f32,
    music: f32,
    effects: f32,
}

impl Default for StemRuntimeGains {
    fn default() -> Self {
        Self {
            dx: 1.0,
            music: 1.0,
            effects: 1.0,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct StemTargetGains {
    dx: f32,
    music: f32,
    effects: f32,
}

impl StemTargetGains {
    fn from_flags(flags: AudioFrameStemFlags) -> Self {
        let any_solo = flags.any_solo();
        let gain_for = |stem: StemState| -> f32 {
            if any_solo {
                if stem.is_solo {
                    1.0
                } else {
                    0.0
                }
            } else if stem.is_muted && !stem.is_solo {
                0.0
            } else {
                1.0
            }
        };

        Self {
            dx: gain_for(flags.dx),
            music: gain_for(flags.music),
            effects: gain_for(flags.effects),
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct AudioFrameStaticLoudness {
    pub dialogue_momentary_lufs: f32,
    pub dialogue_short_term_lufs: f32,
    pub music_momentary_lufs: f32,
    pub music_short_term_lufs: f32,
    pub effects_momentary_lufs: f32,
    pub effects_short_term_lufs: f32,
}

#[derive(Debug, Clone)]
pub struct AudioFrame {
    pub sample_rate: u32,
    pub dialogue_raw: Vec<f32>,
    /// Summed music+effects mix — retained for spatial/spectral analysis.
    pub background_raw: Vec<f32>,
    /// Individual gain-applied music stem — used by LoudnessAnalyzer.
    pub music_raw: Vec<f32>,
    /// Individual gain-applied effects stem — used by LoudnessAnalyzer.
    pub effects_raw: Vec<f32>,
    pub stem_flags: AudioFrameStemFlags,
    pub static_loudness: Option<AudioFrameStaticLoudness>,
}

impl Default for AudioFrame {
    fn default() -> Self {
        Self {
            sample_rate: 0,
            dialogue_raw: Vec::new(),
            background_raw: Vec::new(),
            music_raw: Vec::new(),
            effects_raw: Vec::new(),
            stem_flags: AudioFrameStemFlags::default(),
            static_loudness: None,
        }
    }
}

impl AudioFrame {
    pub fn len(&self) -> usize {
        self.dialogue_raw.len().min(self.background_raw.len())
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn from_static_loudness(
        sample_rate: u32,
        static_loudness: AudioFrameStaticLoudness,
    ) -> Self {
        Self {
            sample_rate,
            static_loudness: Some(static_loudness),
            ..Self::default()
        }
    }

    pub fn with_static_loudness(mut self, static_loudness: AudioFrameStaticLoudness) -> Self {
        self.static_loudness = Some(static_loudness);
        self
    }
}

pub type SyncedAudioFrame = AudioFrame;

#[derive(Debug, Clone, Copy)]
struct StreamingLinearResampler {
    input_rate: u32,
    output_rate: u32,
    step: f64,
    position: f64,
}

impl StreamingLinearResampler {
    fn new(input_rate: u32, output_rate: u32) -> Self {
        let step = input_rate as f64 / output_rate as f64;
        Self {
            input_rate,
            output_rate,
            step,
            position: 0.0,
        }
    }

    fn process(&mut self, source: &mut Vec<f32>, incoming: &[f32]) -> Vec<f32> {
        if incoming.is_empty() {
            return Vec::new();
        }

        source.extend_from_slice(incoming);
        if source.len() < 2 {
            return Vec::new();
        }

        let mut output = Vec::new();
        while self.position + 1.0 < source.len() as f64 {
            let base = self.position.floor() as usize;
            let frac = self.position - (base as f64);
            let current = source[base];
            let next = source[base + 1];
            output.push((current * (1.0 - frac as f32)) + (next * frac as f32));
            self.position += self.step;
        }

        let consumed = self.position.floor() as usize;
        if consumed > 0 {
            source.drain(0..consumed);
            self.position -= consumed as f64;
        }

        output
    }

    fn is_passthrough(&self) -> bool {
        self.input_rate == self.output_rate
    }

    fn output_rate(&self) -> u32 {
        self.output_rate
    }

    fn reset(&mut self) {
        self.position = 0.0;
    }
}

struct StemStreamDecoder {
    stem_name: &'static str,
    format: Box<dyn FormatReader>,
    decoder: Box<dyn Decoder>,
    track_id: u32,
    pending_samples: VecDeque<f32>,
    resampler: StreamingLinearResampler,
    resampler_source: Vec<f32>,
    eof: bool,
}

impl StemStreamDecoder {
    fn open(
        stem_name: &'static str,
        path: impl AsRef<Path>,
        target_sample_rate: u32,
    ) -> Result<Self, AudioDecodeError> {
        let path = path.as_ref().to_path_buf();
        if !path.exists() {
            return Err(AudioDecodeError::MissingStem {
                stem: stem_name,
                path,
            });
        }
        if !looks_like_wav(&path)? {
            return Err(AudioDecodeError::UnsupportedFormat {
                stem: stem_name,
                path: path.clone(),
                format: "non-wav".to_string(),
            });
        }

        let file = File::open(&path)?;
        let source = MediaSourceStream::new(Box::new(file), Default::default());

        let extension = path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or_default();
        let mut hint = Hint::new();
        if !extension.is_empty() {
            hint.with_extension(extension);
        }

        let probed = get_probe()
            .format(
                &hint,
                source,
                &FormatOptions::default(),
                &MetadataOptions::default(),
            )
            .map_err(|err| AudioDecodeError::Probe(err.to_string()))?;

        let format = probed.format;
        if !extension.eq_ignore_ascii_case("wav") && !extension.eq_ignore_ascii_case("wave") {
            return Err(AudioDecodeError::UnsupportedFormat {
                stem: stem_name,
                path: path.clone(),
                format: extension.to_string(),
            });
        }

        let (track_id, codec_params, sample_rate) = {
            let track = format
                .default_track()
                .ok_or_else(|| AudioDecodeError::NoAudioTrack {
                    stem: stem_name,
                    path: path.clone(),
                })?;
            let sample_rate = track.codec_params.sample_rate.ok_or_else(|| {
                AudioDecodeError::MissingSampleRate {
                    stem: stem_name,
                    path: path.clone(),
                }
            })?;
            (track.id, track.codec_params.clone(), sample_rate)
        };

        let decoder = get_codecs()
            .make(&codec_params, &DecoderOptions::default())
            .map_err(|err| AudioDecodeError::Decode {
                stem: stem_name,
                source: err,
            })?;

        Ok(Self {
            stem_name,
            format,
            decoder,
            track_id,
            pending_samples: VecDeque::new(),
            resampler: StreamingLinearResampler::new(sample_rate, target_sample_rate),
            resampler_source: Vec::new(),
            eof: false,
        })
    }

    fn target_sample_rate(&self) -> u32 {
        self.resampler.output_rate()
    }

    fn fill_until(&mut self, minimum_samples: usize) -> Result<(), AudioDecodeError> {
        while self.pending_samples.len() < minimum_samples && !self.eof {
            let packet = match self.format.next_packet() {
                Ok(packet) => packet,
                Err(SymphoniaError::IoError(err))
                    if err.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    self.eof = true;
                    break;
                }
                Err(SymphoniaError::ResetRequired) => {
                    self.decoder.reset();
                    continue;
                }
                Err(err) => {
                    return Err(AudioDecodeError::Decode {
                        stem: self.stem_name,
                        source: err,
                    });
                }
            };

            if packet.track_id() != self.track_id {
                continue;
            }

            let decoded = match self.decoder.decode(&packet) {
                Ok(decoded) => decoded,
                Err(SymphoniaError::DecodeError(_)) => {
                    // Corrupt packet: skip and continue processing the stream.
                    continue;
                }
                Err(SymphoniaError::IoError(err))
                    if err.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    self.eof = true;
                    break;
                }
                Err(err) => {
                    return Err(AudioDecodeError::Decode {
                        stem: self.stem_name,
                        source: err,
                    });
                }
            };

            let mono = decode_to_normalized_mono(decoded);
            if mono.is_empty() {
                continue;
            }

            if self.resampler.is_passthrough() {
                self.pending_samples.extend(mono);
            } else {
                let resampled = self.resampler.process(&mut self.resampler_source, &mono);
                self.pending_samples.extend(resampled);
            }
        }

        Ok(())
    }

    fn pop_frame(&mut self, frame_size: usize) -> Vec<f32> {
        let take = self.pending_samples.len().min(frame_size);
        self.pending_samples.drain(0..take).collect()
    }

    fn is_finished(&self) -> bool {
        self.eof && self.pending_samples.is_empty()
    }

    fn drain_remaining(&mut self) -> Vec<f32> {
        self.pending_samples.drain(..).collect()
    }

    fn seek(&mut self, seconds: f32) -> Result<(), AudioDecodeError> {
        self.pending_samples.clear();
        self.resampler_source.clear();
        self.resampler.reset();
        self.eof = false;

        self.format
            .seek(
                SeekMode::Accurate,
                SeekTo::Time {
                    time: Time::from(seconds as f64),
                    track_id: Some(self.track_id),
                },
            )
            .map_err(|source| AudioDecodeError::Seek {
                stem: self.stem_name,
                seconds,
                source,
            })?;
        self.decoder.reset();
        Ok(())
    }
}

fn decode_to_normalized_mono(decoded: AudioBufferRef<'_>) -> Vec<f32> {
    let spec = *decoded.spec();
    let channels = spec.channels.count();
    if channels == 0 {
        return Vec::new();
    }

    let mut sample_buffer = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
    sample_buffer.copy_interleaved_ref(decoded);
    let interleaved = sample_buffer.samples();

    interleaved
        .chunks_exact(channels)
        .map(|frame| {
            let sum: f32 = frame.iter().copied().sum();
            let mono = sum / channels as f32;
            mono.clamp(-1.0, 1.0)
        })
        .collect()
}

fn looks_like_wav(path: &Path) -> Result<bool, AudioDecodeError> {
    let mut file = File::open(path)?;
    let mut header = [0_u8; 12];
    let bytes_read = file.read(&mut header)?;
    if bytes_read < header.len() {
        return Ok(false);
    }
    Ok(&header[0..4] == b"RIFF" && &header[8..12] == b"WAVE")
}

pub struct MikupAudioDecoder {
    dx: StemStreamDecoder,
    music: StemStreamDecoder,
    effects: StemStreamDecoder,
    frame_size: usize,
    target_sample_rate: u32,
    stem_states: SharedStemStates,
    stem_runtime_gains: StemRuntimeGains,
    gain_step_per_sample: f32,
    /// Set to true the first time a stem runs out of data while others still have samples,
    /// indicating the source stems have different durations and silence padding is active.
    pub alignment_mismatch_detected: bool,
}

impl MikupAudioDecoder {
    pub fn new(
        dx_path: impl AsRef<Path>,
        music_path: impl AsRef<Path>,
        effects_path: impl AsRef<Path>,
        stem_states: SharedStemStates,
        target_sample_rate: u32,
        frame_size: usize,
    ) -> Result<Self, AudioDecodeError> {
        if target_sample_rate == 0 {
            return Err(AudioDecodeError::InvalidConfig(
                "target_sample_rate must be > 0",
            ));
        }
        if frame_size == 0 {
            return Err(AudioDecodeError::InvalidConfig("frame_size must be > 0"));
        }

        let dx = StemStreamDecoder::open("dx", dx_path, target_sample_rate)?;
        let music = StemStreamDecoder::open("music", music_path, target_sample_rate)?;
        let effects = StemStreamDecoder::open("effects", effects_path, target_sample_rate)?;

        let resolved_sample_rate = dx.target_sample_rate();
        if music.target_sample_rate() != resolved_sample_rate
            || effects.target_sample_rate() != resolved_sample_rate
        {
            return Err(AudioDecodeError::InvalidConfig(
                "stems resolved to mismatched output sample rates",
            ));
        }

        let fade_samples = ((target_sample_rate as f32 * STEM_FADE_MS) / 1000.0)
            .round()
            .max(1.0);

        Ok(Self {
            dx,
            music,
            effects,
            frame_size,
            target_sample_rate,
            stem_states,
            stem_runtime_gains: StemRuntimeGains::default(),
            gain_step_per_sample: 1.0 / fade_samples,
            alignment_mismatch_detected: false,
        })
    }

    pub fn with_defaults(
        dx_path: impl AsRef<Path>,
        music_path: impl AsRef<Path>,
        effects_path: impl AsRef<Path>,
    ) -> Result<Self, AudioDecodeError> {
        Self::new(
            dx_path,
            music_path,
            effects_path,
            shared_default_stem_states(),
            DEFAULT_TARGET_SAMPLE_RATE,
            DEFAULT_FRAME_SIZE,
        )
    }

    pub fn target_sample_rate(&self) -> u32 {
        self.target_sample_rate
    }

    pub fn frame_size(&self) -> usize {
        self.frame_size
    }

    /// Reads a synchronized frame for all stems.
    /// Returns `Ok(None)` when all stems are fully consumed.
    pub fn read_frame(&mut self) -> Result<Option<SyncedAudioFrame>, AudioDecodeError> {
        self.dx.fill_until(self.frame_size)?;
        self.music.fill_until(self.frame_size)?;
        self.effects.fill_until(self.frame_size)?;

        if self.dx.is_finished() && self.music.is_finished() && self.effects.is_finished() {
            return Ok(None);
        }

        let mut dx = self.dx.pop_frame(self.frame_size);
        let mut music = self.music.pop_frame(self.frame_size);
        let mut effects = self.effects.pop_frame(self.frame_size);

        if dx.is_empty() && music.is_empty() && effects.is_empty() {
            if self.dx.is_finished() && self.music.is_finished() && self.effects.is_finished() {
                return Ok(None);
            }

            // If one stem has no decodable data for this step, keep stream alignment with silence.
            dx = vec![0.0; self.frame_size];
            music = vec![0.0; self.frame_size];
            effects = vec![0.0; self.frame_size];
        }

        let max_len = dx.len().max(music.len()).max(effects.len());

        // Detect stems that ran out of data before others — indicates mismatched durations.
        if max_len > 0
            && (dx.len() < max_len || music.len() < max_len || effects.len() < max_len)
        {
            self.alignment_mismatch_detected = true;
        }

        dx.resize(max_len, 0.0);
        music.resize(max_len, 0.0);
        effects.resize(max_len, 0.0);

        Ok(Some(self.process_frame(dx, music, effects)))
    }

    pub fn drain_tail(&mut self) -> SyncedAudioFrame {
        let mut dx = self.dx.drain_remaining();
        let mut music = self.music.drain_remaining();
        let mut effects = self.effects.drain_remaining();

        let max_len = dx.len().max(music.len()).max(effects.len());
        dx.resize(max_len, 0.0);
        music.resize(max_len, 0.0);
        effects.resize(max_len, 0.0);

        self.process_frame(dx, music, effects)
    }

    pub fn seek(&mut self, seconds: f32) -> Result<(), AudioDecodeError> {
        if !seconds.is_finite() || seconds < 0.0 {
            return Err(AudioDecodeError::InvalidConfig(
                "seek seconds must be finite and >= 0",
            ));
        }
        self.dx.seek(seconds)?;
        self.music.seek(seconds)?;
        self.effects.seek(seconds)?;
        Ok(())
    }

    fn process_frame(
        &mut self,
        mut dx: Vec<f32>,
        mut music: Vec<f32>,
        mut effects: Vec<f32>,
    ) -> SyncedAudioFrame {
        let stem_flags = self.snapshot_stem_flags();
        let target_gains = StemTargetGains::from_flags(stem_flags);

        apply_gain_ramp(
            &mut dx,
            &mut self.stem_runtime_gains.dx,
            target_gains.dx,
            self.gain_step_per_sample,
        );
        let background = sum_background_stems(
            &mut music,
            &mut effects,
            &mut self.stem_runtime_gains,
            target_gains,
            self.gain_step_per_sample,
        );

        // After sum_background_stems, `music` and `effects` hold the individual
        // gain-applied samples; capture them for per-stem loudness metering.
        SyncedAudioFrame {
            sample_rate: self.target_sample_rate,
            dialogue_raw: dx,
            background_raw: background,
            music_raw: music,
            effects_raw: effects,
            stem_flags,
            static_loudness: None,
        }
    }

    fn snapshot_stem_flags(&self) -> AudioFrameStemFlags {
        let map = match self.stem_states.read() {
            Ok(guard) => guard,
            Err(_) => return AudioFrameStemFlags::default(),
        };
        AudioFrameStemFlags::from_map(&map)
    }
}

fn apply_gain_ramp(buffer: &mut [f32], current_gain: &mut f32, target_gain: f32, step: f32) {
    if buffer.is_empty() {
        *current_gain = target_gain;
        return;
    }

    for sample in buffer.iter_mut() {
        let delta = target_gain - *current_gain;
        if delta.abs() <= step {
            *current_gain = target_gain;
        } else {
            *current_gain += step * delta.signum();
        }
        *sample *= *current_gain;
    }
}

fn sum_background_stems(
    music: &mut [f32],
    effects: &mut [f32],
    runtime_gains: &mut StemRuntimeGains,
    target_gains: StemTargetGains,
    gain_step_per_sample: f32,
) -> Vec<f32> {
    let len = music.len().max(effects.len());
    let mut mixed = vec![0.0; len];

    for (i, mixed_sample) in mixed.iter_mut().enumerate() {
        let music_sample = apply_gain_step(
            music.get(i).copied().unwrap_or(0.0),
            &mut runtime_gains.music,
            target_gains.music,
            gain_step_per_sample,
        );
        if let Some(slot) = music.get_mut(i) {
            *slot = music_sample;
        }

        let effects_sample = apply_gain_step(
            effects.get(i).copied().unwrap_or(0.0),
            &mut runtime_gains.effects,
            target_gains.effects,
            gain_step_per_sample,
        );
        if let Some(slot) = effects.get_mut(i) {
            *slot = effects_sample;
        }

        *mixed_sample = music_sample + effects_sample;
    }

    mixed
}

fn apply_gain_step(sample: f32, current_gain: &mut f32, target_gain: f32, step: f32) -> f32 {
    let delta = target_gain - *current_gain;
    if delta.abs() <= step {
        *current_gain = target_gain;
    } else {
        *current_gain += step * delta.signum();
    }
    sample * *current_gain
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solo_takes_precedence_over_muted_background_stems() {
        let flags = AudioFrameStemFlags {
            dx: StemState::default(),
            music: StemState {
                is_solo: false,
                is_muted: false,
            },
            effects: StemState {
                is_solo: true,
                is_muted: true,
            },
        };
        let gains = StemTargetGains::from_flags(flags);

        assert_eq!(gains.music, 0.0);
        // Solo wins for the selected stem even if it is also muted.
        assert_eq!(gains.effects, 1.0);
    }

    #[test]
    fn gain_step_moves_toward_target_without_jumps() {
        let mut gain = 1.0_f32;
        let step = 0.1_f32;
        let sample = apply_gain_step(1.0, &mut gain, 0.0, step);
        assert!((sample - 0.9).abs() < 1e-6);
        assert!((gain - 0.9).abs() < 1e-6);
    }
}
