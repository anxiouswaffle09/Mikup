use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;

use ebur128::{EbuR128, Mode};
use symphonia::core::audio::{AudioBufferRef, SampleBuffer};
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::default::{get_codecs, get_probe};

const LUFS_FLOOR: f32 = -70.0;
const LUFS_CEILING: f32 = 0.0;
const STEM_SCAN_PROGRESS_INTERVAL_SECS: f32 = 5.0;

pub const CANONICAL_STEMS: [&str; 3] = ["DX", "Music", "Effects"];

#[derive(Debug, Clone, serde::Serialize)]
pub struct StemLufsProfile {
    pub integrated: f32,
    pub loudness_range_lu: f32,
    pub momentary: Vec<f32>,
    pub short_term: Vec<f32>,
}

#[derive(Debug, Clone)]
pub enum ScanEvent {
    StemStarted { stem: String },
    StemProgress { stem: String, seconds_scanned: f32 },
    StemFinished { stem: String },
}

#[derive(Debug)]
pub enum ScannerError {
    InvalidConfig(&'static str),
    MissingStemPath { stem: &'static str },
    MissingStemFile { stem: String, path: PathBuf },
    InvalidStemFormat { stem: String, path: PathBuf },
    Probe(String),
    Decode { stem: String, message: String },
    Meter(String),
    ThreadJoin(String),
}

impl std::fmt::Display for ScannerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidConfig(msg) => write!(f, "Invalid scanner config: {msg}"),
            Self::MissingStemPath { stem } => write!(f, "Missing required stem path for {stem}"),
            Self::MissingStemFile { stem, path } => {
                write!(f, "Missing stem file for {stem}: {}", path.display())
            }
            Self::InvalidStemFormat { stem, path } => write!(
                f,
                "Stem file for {stem} is not a valid WAV file: {}",
                path.display()
            ),
            Self::Probe(msg) => write!(f, "Unable to probe stem: {msg}"),
            Self::Decode { stem, message } => write!(f, "Decode failure in {stem}: {message}"),
            Self::Meter(msg) => write!(f, "EBU R128 meter failure: {msg}"),
            Self::ThreadJoin(msg) => write!(f, "Thread join failure: {msg}"),
        }
    }
}

impl std::error::Error for ScannerError {}

#[derive(Debug, Clone, Copy)]
pub struct OfflineLoudnessScanner {
    points_per_second: u32,
}

impl Default for OfflineLoudnessScanner {
    fn default() -> Self {
        Self {
            points_per_second: 2,
        }
    }
}

impl OfflineLoudnessScanner {
    pub fn new(points_per_second: u32) -> Result<Self, ScannerError> {
        if !(1..=2).contains(&points_per_second) {
            return Err(ScannerError::InvalidConfig(
                "points_per_second must be 1 or 2",
            ));
        }
        Ok(Self { points_per_second })
    }

    pub fn resolve_required_stems(
        stem_paths: &HashMap<String, String>,
    ) -> Result<HashMap<String, PathBuf>, ScannerError> {
        let mut resolved = HashMap::with_capacity(CANONICAL_STEMS.len());
        for stem in CANONICAL_STEMS {
            let value = lookup_stem_path(stem_paths, stem)
                .ok_or(ScannerError::MissingStemPath { stem })?
                .trim()
                .to_string();
            if value.is_empty() {
                return Err(ScannerError::MissingStemPath { stem });
            }
            resolved.insert(stem.to_string(), PathBuf::from(value));
        }
        Ok(resolved)
    }

    pub fn scan<F>(
        &self,
        stem_paths: HashMap<String, PathBuf>,
        mut on_event: F,
    ) -> Result<HashMap<String, StemLufsProfile>, ScannerError>
    where
        F: FnMut(ScanEvent),
    {
        let (event_tx, event_rx) = mpsc::channel::<ScanEvent>();

        let mut handles = Vec::with_capacity(CANONICAL_STEMS.len());
        for stem in CANONICAL_STEMS {
            let scanner = *self;
            let stem_name = stem.to_string();
            let path = stem_paths
                .get(stem)
                .cloned()
                .ok_or(ScannerError::MissingStemPath { stem })?;
            let tx = event_tx.clone();

            let handle =
                thread::spawn(move || -> Result<(String, StemLufsProfile), ScannerError> {
                    let _ = tx.send(ScanEvent::StemStarted {
                        stem: stem_name.clone(),
                    });

                    let stem_for_progress = stem_name.clone();
                    let mut next_progress_secs = STEM_SCAN_PROGRESS_INTERVAL_SECS;
                    let profile = scanner.scan_stem(&stem_name, &path, |seconds| {
                        if seconds >= next_progress_secs {
                            let _ = tx.send(ScanEvent::StemProgress {
                                stem: stem_for_progress.clone(),
                                seconds_scanned: seconds,
                            });
                            next_progress_secs += STEM_SCAN_PROGRESS_INTERVAL_SECS;
                        }
                    })?;

                    let _ = tx.send(ScanEvent::StemFinished {
                        stem: stem_name.clone(),
                    });

                    Ok((stem_name, profile))
                });

            handles.push(handle);
        }
        drop(event_tx);

        for event in event_rx {
            on_event(event);
        }

        let mut profiles = HashMap::with_capacity(CANONICAL_STEMS.len());
        for handle in handles {
            match handle.join() {
                Ok(Ok((stem, profile))) => {
                    profiles.insert(stem, profile);
                }
                Ok(Err(err)) => return Err(err),
                Err(_) => {
                    return Err(ScannerError::ThreadJoin(
                        "scanner worker thread panicked".to_string(),
                    ))
                }
            }
        }

        Ok(profiles)
    }

    fn scan_stem<F>(
        &self,
        stem_name: &str,
        path: &Path,
        mut on_progress: F,
    ) -> Result<StemLufsProfile, ScannerError>
    where
        F: FnMut(f32),
    {
        if !path.exists() {
            return Err(ScannerError::MissingStemFile {
                stem: stem_name.to_string(),
                path: path.to_path_buf(),
            });
        }
        if !looks_like_wav(path)? {
            return Err(ScannerError::InvalidStemFormat {
                stem: stem_name.to_string(),
                path: path.to_path_buf(),
            });
        }

        let file = std::fs::File::open(path).map_err(|e| ScannerError::Decode {
            stem: stem_name.to_string(),
            message: e.to_string(),
        })?;

        let mss = MediaSourceStream::new(Box::new(file), Default::default());
        let mut hint = Hint::new();
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            hint.with_extension(ext);
        }

        let probed = get_probe()
            .format(
                &hint,
                mss,
                &FormatOptions::default(),
                &MetadataOptions::default(),
            )
            .map_err(|e| ScannerError::Probe(e.to_string()))?;

        let mut format = probed.format;

        let track = format.default_track().ok_or_else(|| ScannerError::Decode {
            stem: stem_name.to_string(),
            message: "No decodable audio track found".to_string(),
        })?;
        let track_id = track.id;
        let codec_params = track.codec_params.clone();
        let sample_rate = codec_params
            .sample_rate
            .ok_or_else(|| ScannerError::Decode {
                stem: stem_name.to_string(),
                message: "Missing sample-rate metadata".to_string(),
            })?;

        let mut decoder = get_codecs()
            .make(&codec_params, &DecoderOptions::default())
            .map_err(|e| ScannerError::Decode {
                stem: stem_name.to_string(),
                message: e.to_string(),
            })?;

        let mut meter = EbuR128::new(1, sample_rate, Mode::M | Mode::S | Mode::I | Mode::LRA)
            .map_err(|e| ScannerError::Meter(e.to_string()))?;

        let capture_step_samples = sample_rate as f64 / self.points_per_second as f64;
        let mut next_capture_sample = 0.0_f64;
        let mut processed_samples = 0_u64;
        let mut momentary = Vec::new();
        let mut short_term = Vec::new();

        loop {
            let packet = match format.next_packet() {
                Ok(packet) => packet,
                Err(SymphoniaError::IoError(err))
                    if err.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    break;
                }
                Err(SymphoniaError::ResetRequired) => {
                    decoder.reset();
                    continue;
                }
                Err(err) => {
                    return Err(ScannerError::Decode {
                        stem: stem_name.to_string(),
                        message: err.to_string(),
                    })
                }
            };

            if packet.track_id() != track_id {
                continue;
            }

            let decoded = match decoder.decode(&packet) {
                Ok(decoded) => decoded,
                Err(SymphoniaError::DecodeError(_)) => {
                    continue;
                }
                Err(SymphoniaError::IoError(err))
                    if err.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    break;
                }
                Err(err) => {
                    return Err(ScannerError::Decode {
                        stem: stem_name.to_string(),
                        message: err.to_string(),
                    })
                }
            };

            let mono = decode_to_normalized_mono(decoded);
            if mono.is_empty() {
                continue;
            }

            meter
                .add_frames_f32(&mono)
                .map_err(|e| ScannerError::Meter(e.to_string()))?;
            processed_samples += mono.len() as u64;

            while (processed_samples as f64) >= next_capture_sample {
                momentary.push(read_lufs(meter.loudness_momentary()));
                short_term.push(read_lufs(meter.loudness_shortterm()));
                next_capture_sample += capture_step_samples;
            }

            on_progress(processed_samples as f32 / sample_rate as f32);
        }

        Ok(StemLufsProfile {
            integrated: read_lufs(meter.loudness_global()),
            loudness_range_lu: read_lu(meter.loudness_range()),
            momentary,
            short_term,
        })
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

fn looks_like_wav(path: &Path) -> Result<bool, ScannerError> {
    let mut file = std::fs::File::open(path).map_err(|e| ScannerError::Decode {
        stem: path.display().to_string(),
        message: e.to_string(),
    })?;
    let mut header = [0_u8; 12];
    let bytes_read =
        std::io::Read::read(&mut file, &mut header).map_err(|e| ScannerError::Decode {
            stem: path.display().to_string(),
            message: e.to_string(),
        })?;
    if bytes_read < header.len() {
        return Ok(false);
    }
    Ok(&header[0..4] == b"RIFF" && &header[8..12] == b"WAVE")
}

fn read_lufs(value: Result<f64, ebur128::Error>) -> f32 {
    match value {
        Ok(lufs) if lufs.is_finite() => (lufs as f32).clamp(LUFS_FLOOR, LUFS_CEILING),
        _ => LUFS_FLOOR,
    }
}

fn read_lu(value: Result<f64, ebur128::Error>) -> f32 {
    match value {
        Ok(v) if v.is_finite() && v >= 0.0 => v as f32,
        _ => 0.0,
    }
}

fn lookup_stem_path<'a>(
    stem_paths: &'a HashMap<String, String>,
    stem: &'static str,
) -> Option<&'a str> {
    stem_paths
        .iter()
        .find_map(|(k, v)| k.eq_ignore_ascii_case(stem).then_some(v.as_str()))
        .or_else(|| {
            let aliases: &[&str] = match stem {
                "DX" => &["dialogue_raw", "dx_raw", "dialogue"],
                "Music" => &["music_raw", "background_raw", "music"],
                "Effects" => &["effects_raw", "effects", "background_raw"],
                _ => &[],
            };

            aliases.iter().find_map(|alias| {
                stem_paths
                    .iter()
                    .find_map(|(k, v)| k.eq_ignore_ascii_case(alias).then_some(v.as_str()))
            })
        })
}
