use std::collections::HashMap;
use std::fs;
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

use super::loudness::{LoudnessAnalyzer, LoudnessError};
use super::{shared_default_stem_states, AudioDecodeError, MikupAudioDecoder, SyncedAudioFrame};

const LUFS_FLOOR: f32 = -70.0;
const LUFS_CEILING: f32 = 0.0;
const STEM_SCAN_PROGRESS_INTERVAL_SECS: f32 = 5.0;
const TELEMETRY_CACHE_MAGIC: [u8; 8] = *b"MIKUP\0\0\0";
const TELEMETRY_CACHE_VERSION: u32 = 2;
const TELEMETRY_SAMPLE_RATE: u32 = 48_000;
const TELEMETRY_POINTS_PER_SECOND: u32 = 10;
const TELEMETRY_FRAME_SIZE: usize = (TELEMETRY_SAMPLE_RATE / TELEMETRY_POINTS_PER_SECOND) as usize;
const WAVEFORM_TARGET_COLUMNS: usize = 1_000;

pub const CANONICAL_STEMS: [&str; 3] = ["DX", "Music", "Effects"];
pub const TELEMETRY_CACHE_FILE_NAME: &str = ".mikup_cache";
const WAVEFORM_SECTION_COUNT: usize = 4;

#[derive(Debug, Clone, serde::Serialize)]
pub struct StemLufsProfile {
    pub integrated: f32,
    pub loudness_range_lu: f32,
    pub momentary: Vec<f32>,
    pub short_term: Vec<f32>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct WaveformPeak {
    pub min: f32,
    pub max: f32,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct LufsTelemetrySample {
    pub dx: f32,
    pub music: f32,
    pub effects: f32,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct TelemetryCache {
    pub sample_rate: u32,
    pub master_waveform: Vec<WaveformPeak>,
    pub dx_waveform: Vec<WaveformPeak>,
    pub music_waveform: Vec<WaveformPeak>,
    pub effects_waveform: Vec<WaveformPeak>,
    pub lufs_samples: Vec<LufsTelemetrySample>,
    pub master_lufs: Vec<f32>,
    pub pacing_density: Vec<f32>,
}

impl TelemetryCache {
    pub fn waveform_columns(&self) -> usize {
        self.master_waveform.len()
    }
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
    Io(std::io::Error),
    AudioDecode(AudioDecodeError),
    Loudness(LoudnessError),
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
            Self::Io(err) => write!(f, "Cache I/O failure: {err}"),
            Self::AudioDecode(err) => write!(f, "Audio decode failure: {err}"),
            Self::Loudness(err) => write!(f, "Loudness analysis failure: {err}"),
        }
    }
}

impl std::error::Error for ScannerError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(err) => Some(err),
            Self::AudioDecode(err) => Some(err),
            Self::Loudness(err) => Some(err),
            _ => None,
        }
    }
}

impl From<std::io::Error> for ScannerError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<AudioDecodeError> for ScannerError {
    fn from(value: AudioDecodeError) -> Self {
        Self::AudioDecode(value)
    }
}

impl From<LoudnessError> for ScannerError {
    fn from(value: LoudnessError) -> Self {
        Self::Loudness(value)
    }
}

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
                    ));
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
        ensure_valid_wav(path, stem_name)?;

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
                    });
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
                    });
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

pub fn generate_telemetry_cache(
    dx_path: impl AsRef<Path>,
    mx_path: impl AsRef<Path>,
    fx_path: impl AsRef<Path>,
    source_path: Option<&Path>,
    pacing_density: &[f32],
    out_path: impl AsRef<Path>,
) -> Result<TelemetryCache, ScannerError> {
    let dx_path = dx_path.as_ref();
    let mx_path = mx_path.as_ref();
    let fx_path = fx_path.as_ref();
    let out_path = out_path.as_ref();

    ensure_valid_wav(dx_path, "DX")?;
    ensure_valid_wav(mx_path, "Music")?;
    ensure_valid_wav(fx_path, "Effects")?;

    let mut decoder = MikupAudioDecoder::new(
        dx_path,
        mx_path,
        fx_path,
        source_path,
        shared_default_stem_states(),
        TELEMETRY_SAMPLE_RATE,
        TELEMETRY_FRAME_SIZE,
    )?;
    let mut loudness = LoudnessAnalyzer::new(decoder.target_sample_rate())?;
    let mut master_meter = EbuR128::new(
        1,
        decoder.target_sample_rate(),
        Mode::M | Mode::S | Mode::I | Mode::LRA,
    )
    .map_err(|e| ScannerError::Meter(e.to_string()))?;

    let mut master_peaks = Vec::new();
    let mut dx_peaks = Vec::new();
    let mut music_peaks = Vec::new();
    let mut effects_peaks = Vec::new();
    let mut lufs_samples = Vec::new();
    let mut master_lufs = Vec::new();

    while let Some(frame) = decoder.read_frame()? {
        if frame.is_empty() {
            continue;
        }

        let _ = loudness.process_frame(frame)?;
        let final_metrics = loudness.final_metrics();
        let master_frame = resolve_master_frame(frame);
        master_meter
            .add_frames_f32(&master_frame)
            .map_err(|e| ScannerError::Meter(e.to_string()))?;

        master_peaks.push(compute_peak(&master_frame));
        dx_peaks.push(compute_peak(&frame.dialogue_raw));
        music_peaks.push(compute_peak(&frame.music_raw));
        effects_peaks.push(compute_peak(&frame.effects_raw));
        lufs_samples.push(LufsTelemetrySample {
            dx: final_metrics.dialogue.integrated_lufs,
            music: final_metrics.music.integrated_lufs,
            effects: final_metrics.effects.integrated_lufs,
        });
        master_lufs.push(read_lufs(master_meter.loudness_global()));
    }

    let aligned_pacing_density = align_series(pacing_density, lufs_samples.len());

    let cache = TelemetryCache {
        sample_rate: decoder.target_sample_rate(),
        master_waveform: downsample_waveform(&master_peaks, WAVEFORM_TARGET_COLUMNS),
        dx_waveform: downsample_waveform(&dx_peaks, WAVEFORM_TARGET_COLUMNS),
        music_waveform: downsample_waveform(&music_peaks, WAVEFORM_TARGET_COLUMNS),
        effects_waveform: downsample_waveform(&effects_peaks, WAVEFORM_TARGET_COLUMNS),
        lufs_samples,
        master_lufs,
        pacing_density: aligned_pacing_density,
    };

    write_telemetry_cache(out_path, &cache)?;

    Ok(cache)
}

pub fn load_telemetry_cache(path: impl AsRef<Path>) -> Option<TelemetryCache> {
    let bytes = fs::read(path).ok()?;
    parse_telemetry_cache(&bytes)
}

fn write_telemetry_cache(path: &Path, cache: &TelemetryCache) -> Result<(), ScannerError> {
    let bytes = serialize_telemetry_cache(cache)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let temp_name = format!(
        "{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(TELEMETRY_CACHE_FILE_NAME)
    );
    let temp_path = path.with_file_name(temp_name);
    fs::write(&temp_path, bytes)?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(temp_path, path)?;
    Ok(())
}

fn serialize_telemetry_cache(cache: &TelemetryCache) -> Result<Vec<u8>, ScannerError> {
    if cache.master_waveform.len() != cache.dx_waveform.len()
        || cache.master_waveform.len() != cache.music_waveform.len()
        || cache.master_waveform.len() != cache.effects_waveform.len()
    {
        return Err(ScannerError::InvalidConfig(
            "waveform sections must contain matching column counts",
        ));
    }
    if cache.master_lufs.len() != cache.lufs_samples.len()
        || cache.pacing_density.len() != cache.lufs_samples.len()
    {
        return Err(ScannerError::InvalidConfig(
            "master LUFS and pacing density must match LUFS sample count",
        ));
    }

    let waveform_columns = cache
        .master_waveform
        .len()
        .checked_mul(WAVEFORM_SECTION_COUNT)
        .ok_or(ScannerError::InvalidConfig("waveform section too large"))?;
    let waveform_columns_u32 = u32::try_from(cache.master_waveform.len())
        .map_err(|_| ScannerError::InvalidConfig("waveform section too large"))?;
    let lufs_len_u32 = u32::try_from(cache.lufs_samples.len())
        .map_err(|_| ScannerError::InvalidConfig("LUFS section too large"))?;

    let mut bytes =
        Vec::with_capacity(24 + waveform_columns * 8 + cache.lufs_samples.len() * (12 + 4 + 4));
    bytes.extend_from_slice(&TELEMETRY_CACHE_MAGIC);
    bytes.extend_from_slice(&TELEMETRY_CACHE_VERSION.to_le_bytes());
    bytes.extend_from_slice(&cache.sample_rate.to_le_bytes());
    bytes.extend_from_slice(&waveform_columns_u32.to_le_bytes());
    bytes.extend_from_slice(&lufs_len_u32.to_le_bytes());

    for peaks in [
        cache.master_waveform.as_slice(),
        cache.dx_waveform.as_slice(),
        cache.music_waveform.as_slice(),
        cache.effects_waveform.as_slice(),
    ] {
        for peak in peaks {
            bytes.extend_from_slice(&peak.min.to_le_bytes());
            bytes.extend_from_slice(&peak.max.to_le_bytes());
        }
    }

    for sample in &cache.lufs_samples {
        bytes.extend_from_slice(&sample.dx.to_le_bytes());
        bytes.extend_from_slice(&sample.music.to_le_bytes());
        bytes.extend_from_slice(&sample.effects.to_le_bytes());
    }
    for sample in &cache.master_lufs {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    for sample in &cache.pacing_density {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }

    Ok(bytes)
}

fn parse_telemetry_cache(bytes: &[u8]) -> Option<TelemetryCache> {
    if bytes.len() < 24 || bytes[0..8] != TELEMETRY_CACHE_MAGIC {
        return None;
    }

    let version = read_u32(bytes, 8)?;
    if version != TELEMETRY_CACHE_VERSION {
        return None;
    }

    let sample_rate = read_u32(bytes, 12)?;
    let waveform_columns = read_u32(bytes, 16)? as usize;
    let lufs_len = read_u32(bytes, 20)? as usize;
    let mut cursor: usize = 24;

    let waveform_len = waveform_columns.checked_mul(WAVEFORM_SECTION_COUNT)?;
    let waveform_bytes = waveform_len.checked_mul(8)?;
    let waveform_end = cursor.checked_add(waveform_bytes)?;
    if waveform_end > bytes.len() {
        return None;
    }

    let peaks = read_waveform_section(&bytes[cursor..waveform_end], waveform_len)?;
    cursor = waveform_end;

    let lufs_bytes = lufs_len.checked_mul(12)?;
    let lufs_end = cursor.checked_add(lufs_bytes)?;
    if lufs_end > bytes.len() {
        return None;
    }

    let lufs_samples = read_lufs_section(&bytes[cursor..lufs_end], lufs_len)?;
    cursor = lufs_end;

    let master_bytes = lufs_len.checked_mul(4)?;
    let master_end = cursor.checked_add(master_bytes)?;
    if master_end > bytes.len() {
        return None;
    }
    let master_lufs = read_float_series(&bytes[cursor..master_end], lufs_len)?;
    cursor = master_end;

    let pacing_bytes = lufs_len.checked_mul(4)?;
    let pacing_end = cursor.checked_add(pacing_bytes)?;
    if pacing_end != bytes.len() {
        return None;
    }
    let pacing_density = read_float_series(&bytes[cursor..pacing_end], lufs_len)?;

    let dx_start = waveform_columns;
    let music_start = waveform_columns * 2;
    let effects_start = waveform_columns * 3;
    Some(TelemetryCache {
        sample_rate,
        master_waveform: peaks[0..waveform_columns].to_vec(),
        dx_waveform: peaks[dx_start..music_start].to_vec(),
        music_waveform: peaks[music_start..effects_start].to_vec(),
        effects_waveform: peaks[effects_start..].to_vec(),
        lufs_samples,
        master_lufs,
        pacing_density,
    })
}

fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    let end = offset.checked_add(4)?;
    let raw: [u8; 4] = bytes.get(offset..end)?.try_into().ok()?;
    Some(u32::from_le_bytes(raw))
}

fn read_f32(bytes: &[u8], offset: usize) -> Option<f32> {
    let end = offset.checked_add(4)?;
    let raw: [u8; 4] = bytes.get(offset..end)?.try_into().ok()?;
    Some(f32::from_le_bytes(raw))
}

fn read_waveform_section(bytes: &[u8], len: usize) -> Option<Vec<WaveformPeak>> {
    let mut peaks = Vec::with_capacity(len);
    for idx in 0..len {
        let offset = idx.checked_mul(8)?;
        peaks.push(WaveformPeak {
            min: read_f32(bytes, offset)?,
            max: read_f32(bytes, offset + 4)?,
        });
    }
    Some(peaks)
}

fn read_lufs_section(bytes: &[u8], len: usize) -> Option<Vec<LufsTelemetrySample>> {
    let mut samples = Vec::with_capacity(len);
    for idx in 0..len {
        let offset = idx.checked_mul(12)?;
        samples.push(LufsTelemetrySample {
            dx: read_f32(bytes, offset)?,
            music: read_f32(bytes, offset + 4)?,
            effects: read_f32(bytes, offset + 8)?,
        });
    }
    Some(samples)
}

fn read_float_series(bytes: &[u8], len: usize) -> Option<Vec<f32>> {
    let mut samples = Vec::with_capacity(len);
    for idx in 0..len {
        let offset = idx.checked_mul(4)?;
        samples.push(read_f32(bytes, offset)?);
    }
    Some(samples)
}

fn compute_peak(samples: &[f32]) -> WaveformPeak {
    if samples.is_empty() {
        return WaveformPeak::default();
    }

    let mut min = f32::INFINITY;
    let mut max = f32::NEG_INFINITY;
    for &sample in samples {
        min = min.min(sample);
        max = max.max(sample);
    }

    WaveformPeak { min, max }
}

fn resolve_master_frame(frame: &SyncedAudioFrame) -> Vec<f32> {
    if !frame.source_raw.is_empty() {
        return frame.source_raw.clone();
    }

    let len = frame
        .dialogue_raw
        .len()
        .max(frame.music_raw.len())
        .max(frame.effects_raw.len());
    let mut mixed = Vec::with_capacity(len);
    for index in 0..len {
        let sample = frame.dialogue_raw.get(index).copied().unwrap_or(0.0)
            + frame.music_raw.get(index).copied().unwrap_or(0.0)
            + frame.effects_raw.get(index).copied().unwrap_or(0.0);
        mixed.push(sample.clamp(-1.0, 1.0));
    }
    mixed
}

fn align_series(values: &[f32], target_len: usize) -> Vec<f32> {
    if target_len == 0 {
        return Vec::new();
    }
    if values.is_empty() {
        return vec![0.0; target_len];
    }
    if values.len() == target_len {
        return values.to_vec();
    }
    if target_len == 1 {
        return vec![values[0]];
    }

    let mut aligned = Vec::with_capacity(target_len);
    for index in 0..target_len {
        let source_index = index * values.len() / target_len;
        aligned.push(values[source_index.min(values.len() - 1)]);
    }
    aligned
}

fn downsample_waveform(peaks: &[WaveformPeak], target_columns: usize) -> Vec<WaveformPeak> {
    if peaks.is_empty() || target_columns == 0 {
        return Vec::new();
    }
    if peaks.len() <= target_columns {
        return peaks.to_vec();
    }

    let mut reduced = Vec::with_capacity(target_columns);
    for column in 0..target_columns {
        let start = column * peaks.len() / target_columns;
        let end = ((column + 1) * peaks.len() / target_columns).max(start + 1);
        let slice = &peaks[start..end.min(peaks.len())];
        let mut min = f32::INFINITY;
        let mut max = f32::NEG_INFINITY;
        for peak in slice {
            min = min.min(peak.min);
            max = max.max(peak.max);
        }
        reduced.push(WaveformPeak { min, max });
    }
    reduced
}

fn ensure_valid_wav(path: &Path, stem_name: &str) -> Result<(), ScannerError> {
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
    Ok(())
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
                "Effects" => &["effects_raw", "sfx", "foley", "ambience"],
                _ => &[],
            };

            aliases.iter().find_map(|alias| {
                stem_paths
                    .iter()
                    .find_map(|(k, v)| k.eq_ignore_ascii_case(alias).then_some(v.as_str()))
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn telemetry_cache_round_trip_preserves_data() {
        let cache = TelemetryCache {
            sample_rate: TELEMETRY_SAMPLE_RATE,
            master_waveform: vec![
                WaveformPeak {
                    min: -0.9,
                    max: 0.95,
                },
                WaveformPeak {
                    min: -0.7,
                    max: 0.6,
                },
            ],
            dx_waveform: vec![
                WaveformPeak {
                    min: -0.5,
                    max: 0.75,
                },
                WaveformPeak {
                    min: -0.25,
                    max: 0.5,
                },
            ],
            music_waveform: vec![
                WaveformPeak {
                    min: -0.8,
                    max: 0.2,
                },
                WaveformPeak {
                    min: -0.6,
                    max: 0.4,
                },
            ],
            effects_waveform: vec![
                WaveformPeak {
                    min: -1.0,
                    max: 1.0,
                },
                WaveformPeak {
                    min: -0.2,
                    max: 0.1,
                },
            ],
            lufs_samples: vec![
                LufsTelemetrySample {
                    dx: -22.0,
                    music: -18.0,
                    effects: -14.0,
                },
                LufsTelemetrySample {
                    dx: -20.0,
                    music: -17.5,
                    effects: -13.0,
                },
            ],
            master_lufs: vec![-19.5, -18.8],
            pacing_density: vec![2.5, 3.0],
        };

        let bytes = serialize_telemetry_cache(&cache).expect("serialize telemetry cache");
        let restored = parse_telemetry_cache(&bytes).expect("parse telemetry cache");

        assert_eq!(restored, cache);
    }

    #[test]
    fn waveform_downsampling_preserves_extrema() {
        let peaks = vec![
            WaveformPeak {
                min: -0.1,
                max: 0.1,
            },
            WaveformPeak {
                min: -0.9,
                max: 0.2,
            },
            WaveformPeak {
                min: -0.2,
                max: 0.8,
            },
            WaveformPeak {
                min: -0.3,
                max: 0.3,
            },
        ];

        let reduced = downsample_waveform(&peaks, 2);

        assert_eq!(
            reduced,
            vec![
                WaveformPeak {
                    min: -0.9,
                    max: 0.2,
                },
                WaveformPeak {
                    min: -0.3,
                    max: 0.8,
                },
            ]
        );
    }

    #[test]
    fn align_series_pads_empty_with_zeroes() {
        assert_eq!(align_series(&[], 3), vec![0.0, 0.0, 0.0]);
    }
}
