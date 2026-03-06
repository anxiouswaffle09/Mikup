use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use rfd::{FileDialog, MessageButtons, MessageDialog, MessageDialogResult, MessageLevel};
use vizia::prelude::*;

use crate::audio_engine::{AudioCmd, AudioController};
use crate::dsp::scanner::{LufsTelemetrySample, WaveformPeak};
use crate::project::{MaskingAlert, Metrics, PacingMikup, Project, TranscriptSegment, WordSegment};
use crate::vectorscope_view::VectorscopeData;

// ── Pipeline stages ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum StageName {
    Separation,
    Transcription,
    Dsp,
    Semantics,
    Director,
}

impl std::fmt::Display for StageName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            Self::Separation => "separation",
            Self::Transcription => "transcription",
            Self::Dsp => "dsp",
            Self::Semantics => "semantics",
            Self::Director => "director",
        };
        f.write_str(s)
    }
}

// ── View state ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum ViewState {
    Landing,
    Processing,
    Workspace,
}

impl Data for ViewState {
    fn same(&self, other: &Self) -> bool {
        self == other
    }
}

// ── Forensic markers ─────────────────────────────────────────────────────────

/// Marker type rendered on the Forensic Graph overlay.
#[derive(Debug, Clone, PartialEq)]
pub enum MarkerKind {
    /// 🏁 Pacing milestone (acceleration/deceleration >30%).
    PacingMilestone,
    /// ⚠ Masking alert (intelligibility SNR below threshold).
    MaskingAlert,
    /// ⚡ Impact peak (sudden transient in Effects/Music).
    ImpactPeak,
    /// ⬇️ Ducking signature (deliberate gain reduction).
    DuckingSignature,
}

/// Single forensic marker pinned to the timeline.
#[derive(Debug, Clone)]
pub struct ForensicMarker {
    /// Timestamp in milliseconds from start of audio.
    pub timestamp_ms: u64,
    /// Duration hint for the marker event (if applicable).
    pub duration_ms: u64,
    /// Marker type determines the icon rendered.
    pub kind: MarkerKind,
    /// Context label (e.g., "[TRAFFIC]", "SNR: 6.2 dB").
    pub context: String,
}

impl ForensicMarker {
    /// Build marker from PacingMikup payload data.
    pub fn from_pacing(p: &PacingMikup) -> Self {
        Self {
            timestamp_ms: (p.timestamp * 1000.0) as u64,
            duration_ms: p.duration_ms,
            kind: MarkerKind::PacingMilestone,
            context: if p.context.is_empty() {
                "Pacing shift".to_string()
            } else {
                p.context.clone()
            },
        }
    }

    /// Build masking alert marker with a caller-provided context label.
    pub fn masking_alert(timestamp_ms: u64, context: impl Into<String>) -> Self {
        Self {
            timestamp_ms,
            duration_ms: 0,
            kind: MarkerKind::MaskingAlert,
            context: context.into(),
        }
    }

    pub fn from_masking(alert: &MaskingAlert) -> Self {
        let mut marker = Self::masking_alert(
            (alert.timestamp * 1000.0) as u64,
            format!("SNR: {:.1} dB", alert.snr),
        );
        marker.duration_ms = alert.duration_ms;
        if !alert.context.is_empty() {
            marker.context = alert.context.clone();
        }
        marker
    }
}

pub fn build_forensic_markers(metrics: &Metrics) -> Vec<ForensicMarker> {
    let mut markers: Vec<ForensicMarker> = metrics
        .pacing_mikups
        .iter()
        .map(ForensicMarker::from_pacing)
        .collect();
    if let Some(diagnostic_meters) = metrics.diagnostic_meters.as_ref() {
        markers.extend(
            diagnostic_meters
                .masking_alerts
                .iter()
                .map(ForensicMarker::from_masking),
        );
    }
    markers.sort_by_key(|marker| marker.timestamp_ms);
    markers
}

// ── Workspace assets ──────────────────────────────────────────────────────────

/// Arc-based bundle of all data the workspace view needs.
/// All fields are cheap-clone Arcs; the struct is `Send` so it can be built
/// on a background thread and sent back via `ContextProxy::emit`.
#[derive(Clone)]
pub struct WorkspaceAssets {
    pub master_waveform: Arc<Vec<WaveformPeak>>,
    pub dx_waveform: Arc<Vec<WaveformPeak>>,
    pub music_waveform: Arc<Vec<WaveformPeak>>,
    pub effects_waveform: Arc<Vec<WaveformPeak>>,
    pub lufs_samples: Arc<Vec<LufsTelemetrySample>>,
    pub master_lufs: Arc<Vec<f32>>,
    pub pacing_density: Arc<Vec<f32>>,
    pub transcript_items: Arc<Vec<(String, u64)>>,
    /// Forensic markers (pacing mikups, masking alerts, etc.) for overlay rendering.
    pub forensic_markers: Arc<Vec<ForensicMarker>>,
    /// Total duration of the audio in milliseconds (for X-axis scaling).
    pub total_duration_ms: u64,
}

/// Newtype so we can implement `Data` for `Option<Arc<WorkspaceAssets>>`
/// without hitting the orphan rule.
#[derive(Clone)]
pub struct MaybeProject(pub Option<Arc<WorkspaceAssets>>);

impl Data for MaybeProject {
    fn same(&self, other: &Self) -> bool {
        match (&self.0, &other.0) {
            (Some(a), Some(b)) => Arc::ptr_eq(a, b),
            (None, None) => true,
            _ => false,
        }
    }
}

// ── App state ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectMetadata {
    pub name: String,
    pub timestamp: DateTime<Utc>,
    pub source_path: PathBuf,
    pub workspace_path: PathBuf,
    pub version: String,
}

impl Data for ProjectMetadata {
    fn same(&self, other: &Self) -> bool {
        self == other
    }
}

#[derive(Lens, Clone)]
pub struct AppData {
    pub volume: f32,
    pub playing: bool,
    pub seek_sensitivity: f32,
    pub is_scrubbing: bool,
    pub project_name: String,
    pub current_view: ViewState,
    pub available_projects: Vec<ProjectMetadata>,
    pub transcript_segments: Vec<TranscriptSegment>,
    pub word_segments: Vec<WordSegment>,
    pub loaded_project: MaybeProject,
    #[lens(ignore)]
    pub engine: Option<Arc<Mutex<AudioController>>>,
    #[lens(ignore)]
    pub vectorscope_data: Arc<Mutex<VectorscopeData>>,
    pub pipeline_progress: f32,
    pub pipeline_message: String,
    pub project_disk_usage: u64,
    pub system_available_space: u64,
    pub system_total_space: u64,
    #[lens(ignore)]
    pub project_dir: Option<PathBuf>,
}

#[derive(Clone)]
pub enum AppEvent {
    TogglePlay,
    SetVolume(f32),
    SeekTo(u64),
    SetSeekSensitivity(f32),
    StartScrubbing,
    StopScrubbing,
    LoadProject(PathBuf),
    SelectNewAudioFile,
    StartPipeline(PathBuf),
    ProjectReady(Arc<WorkspaceAssets>),
    SwitchView(ViewState),
    PipelineProgress(f32, String),
    RedoStage(StageName),
    StorageUpdate {
        usage: u64,
        available: u64,
        total: u64,
    },
    RefreshStorage,
}

impl AppData {
    pub fn apply_event(&mut self, event: AppEvent) {
        match event {
            AppEvent::TogglePlay => {
                if let Some(ref eng) = self.engine {
                    if let Ok(mut guard) = eng.lock() {
                        let _ = guard.cmd_tx.push(if self.playing {
                            AudioCmd::Pause
                        } else {
                            AudioCmd::Play
                        });
                    }
                }
                self.playing = !self.playing;
            }
            AppEvent::SetVolume(v) => self.volume = v.clamp(0.0, 1.0),
            AppEvent::SeekTo(ms) => {
                if let Some(ref eng) = self.engine {
                    if let Ok(mut guard) = eng.lock() {
                        let _ = guard.cmd_tx.push(AudioCmd::Seek(ms));
                    }
                }
            }
            AppEvent::SetSeekSensitivity(v) => self.seek_sensitivity = v.clamp(0.1, 10.0),
            AppEvent::StartScrubbing => {
                self.is_scrubbing = true;
            }
            AppEvent::StopScrubbing => {
                self.is_scrubbing = false;
            }
            AppEvent::ProjectReady(assets) => {
                self.loaded_project = MaybeProject(Some(assets));
                self.current_view = ViewState::Workspace;
                // project_dir is set by LoadProject before ProjectReady arrives
            }
            AppEvent::SwitchView(v) => {
                self.current_view = v;
            }
            AppEvent::PipelineProgress(pct, msg) => {
                self.pipeline_progress = pct;
                self.pipeline_message = msg;
            }
            AppEvent::StorageUpdate {
                usage,
                available,
                total,
            } => {
                self.project_disk_usage = usage;
                self.system_available_space = available;
                self.system_total_space = total;
            }
            // Handled in Model::event (needs cx).
            AppEvent::LoadProject(_)
            | AppEvent::SelectNewAudioFile
            | AppEvent::StartPipeline(_)
            | AppEvent::RedoStage(_)
            | AppEvent::RefreshStorage => {
                tracing::trace!("apply_event: deferred to Model::event context handler");
            }
        }
    }
}

impl Model for AppData {
    fn event(&mut self, cx: &mut EventContext, event: &mut Event) {
        event.map(|e: &AppEvent, _meta| match e.clone() {
            AppEvent::LoadProject(path) => {
                self.current_view = ViewState::Processing;
                self.project_dir = path.parent().map(Path::to_path_buf);
                let engine = self.engine.clone();
                cx.spawn(move |proxy| match Project::load(&path) {
                    Ok(proj) => {
                        // Switch audio engine to the new project's stems
                        if let Some(ref eng) = engine {
                            if let Ok(mut guard) = eng.lock() {
                                let _ = guard.cmd_tx.push(AudioCmd::LoadProject {
                                    dx: proj.stems.dx_path.clone(),
                                    mx: proj.stems.music_path.clone(),
                                    fx: proj.stems.effects_path.clone(),
                                });
                            }
                        }
                        let transcript_items: Vec<(String, u64)> = proj
                            .payload
                            .transcription
                            .segments
                            .iter()
                            .map(|s| {
                                (
                                    format!("[{:.1}s] {}: {}", s.start, s.speaker, s.text),
                                    (s.start * 1000.0) as u64,
                                )
                            })
                            .collect();
                        let forensic_markers = build_forensic_markers(&proj.payload.metrics);
                        let total_duration_ms = proj.telemetry.lufs_samples.len() as u64 * 100;
                        let assets = Arc::new(WorkspaceAssets {
                            master_waveform: Arc::new(proj.telemetry.master_waveform),
                            dx_waveform: Arc::new(proj.telemetry.dx_waveform),
                            music_waveform: Arc::new(proj.telemetry.music_waveform),
                            effects_waveform: Arc::new(proj.telemetry.effects_waveform),
                            lufs_samples: Arc::new(proj.telemetry.lufs_samples),
                            master_lufs: Arc::new(proj.telemetry.master_lufs),
                            pacing_density: Arc::new(proj.telemetry.pacing_density),
                            transcript_items: Arc::new(transcript_items),
                            forensic_markers: Arc::new(forensic_markers),
                            total_duration_ms,
                        });
                        proxy.emit(AppEvent::ProjectReady(assets)).ok();
                        proxy.emit(AppEvent::RefreshStorage).ok();
                    }
                    Err(e) => {
                        eprintln!("[mikup] LoadProject failed: {e}");
                        proxy.emit(AppEvent::SwitchView(ViewState::Landing)).ok();
                    }
                });
            }
            AppEvent::SelectNewAudioFile => {
                cx.spawn(move |proxy| {
                    let selected = FileDialog::new()
                        .add_filter("Audio Files", &["wav", "mp3"])
                        .pick_file();
                    if let Some(path) = selected {
                        proxy.emit(AppEvent::StartPipeline(path)).ok();
                    }
                });
            }
            AppEvent::StartPipeline(path) => {
                self.current_view = ViewState::Processing;
                self.pipeline_progress = 0.0;
                self.pipeline_message = "Starting…".to_string();

                cx.spawn(move |proxy| {
                    let stem = path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("output")
                        .to_string();
                    let output_dir = path
                        .parent()
                        .unwrap_or_else(|| std::path::Path::new("."))
                        .join(format!("{}_mikup", stem));

                    let (input_str, output_str) = match (path.to_str(), output_dir.to_str()) {
                        (Some(i), Some(o)) => (i.to_string(), o.to_string()),
                        _ => {
                            eprintln!("[mikup] Path contains non-UTF-8 bytes");
                            proxy.emit(AppEvent::SwitchView(ViewState::Landing)).ok();
                            return;
                        }
                    };

                    // Project root is one level above the native/ crate.
                    let project_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                        .parent()
                        .map(|p| p.to_path_buf())
                        .unwrap_or_else(|| std::path::PathBuf::from("."));

                    // Resolve the venv python, falling back to system python3.
                    let python_bin: std::ffi::OsString = {
                        let candidates: &[&[&str]] = &[
                            &[".venv", "bin", "python3"],
                            &[".venv", "bin", "python"],
                            &[".venv", "Scripts", "python.exe"],
                        ];
                        candidates
                            .iter()
                            .map(|parts| parts.iter().fold(project_root.clone(), |p, s| p.join(s)))
                            .find(|p| p.exists())
                            .map(|p| p.into_os_string())
                            .unwrap_or_else(|| std::ffi::OsString::from("python3"))
                    };

                    let mut child = match std::process::Command::new(&python_bin)
                        .args([
                            "-m",
                            "src.main",
                            "--input",
                            input_str.as_str(),
                            "--output-dir",
                            output_str.as_str(),
                        ])
                        .current_dir(&project_root)
                        .stdout(std::process::Stdio::piped())
                        .stderr(std::process::Stdio::inherit())
                        .spawn()
                    {
                        Ok(c) => c,
                        Err(e) => {
                            eprintln!("[mikup] Failed to spawn {python_bin:?}: {e}");
                            proxy.emit(AppEvent::SwitchView(ViewState::Landing)).ok();
                            return;
                        }
                    };

                    let stdout = child.stdout.take().expect("stdout must be piped");
                    {
                        use std::io::BufRead;
                        let reader = std::io::BufReader::new(stdout);
                        for line in reader.lines().map_while(Result::ok) {
                            if let Ok(val) =
                                serde_json::from_str::<serde_json::Value>(&line)
                            {
                                if val
                                    .get("type")
                                    .and_then(|t| t.as_str())
                                    == Some("progress")
                                {
                                    let progress = val
                                        .get("progress")
                                        .and_then(|p| p.as_f64())
                                        .unwrap_or(0.0) as f32;
                                    let message = val
                                        .get("message")
                                        .and_then(|m| m.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    proxy
                                        .emit(AppEvent::PipelineProgress(progress, message))
                                        .ok();
                                }
                            }
                        }
                    }

                    match child.wait() {
                        Ok(s) if s.success() => {
                            proxy
                                .emit(AppEvent::LoadProject(
                                    output_dir.join("mikup_payload.json"),
                                ))
                                .ok();
                        }
                        Ok(s) => {
                            eprintln!(
                                "[mikup] Pipeline exited {}",
                                s.code().unwrap_or(-1)
                            );
                            proxy.emit(AppEvent::SwitchView(ViewState::Landing)).ok();
                        }
                        Err(e) => {
                            eprintln!("[mikup] Pipeline wait error: {e}");
                            proxy.emit(AppEvent::SwitchView(ViewState::Landing)).ok();
                        }
                    }
                });
            }
            AppEvent::RedoStage(stage) => {
                let confirm = MessageDialog::new()
                    .set_level(MessageLevel::Warning)
                    .set_title("Redo Stage")
                    .set_description("Re-running this stage will permanently delete all downstream artifacts. Continue?")
                    .set_buttons(MessageButtons::OkCancel)
                    .show();

                if confirm != MessageDialogResult::Ok {
                    return;
                }

                let project_dir = self.project_dir.clone();
                self.current_view = ViewState::Processing;
                self.pipeline_progress = 0.0;
                self.pipeline_message = format!("Re-running {stage}...");

                cx.spawn(move |proxy| {
                    let Some(dir) = project_dir else {
                        eprintln!("[mikup] No project loaded for redo");
                        proxy.emit(AppEvent::SwitchView(ViewState::Landing)).ok();
                        return;
                    };

                    let project_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                        .parent()
                        .map(|p| p.to_path_buf())
                        .unwrap_or_else(|| std::path::PathBuf::from("."));

                    let python_bin: std::ffi::OsString = {
                        let candidates: &[&[&str]] = &[
                            &[".venv", "bin", "python3"],
                            &[".venv", "bin", "python"],
                            &[".venv", "Scripts", "python.exe"],
                        ];
                        candidates
                            .iter()
                            .map(|parts| parts.iter().fold(project_root.clone(), |p, s| p.join(s)))
                            .find(|p| p.exists())
                            .map(|p| p.into_os_string())
                            .unwrap_or_else(|| std::ffi::OsString::from("python3"))
                    };

                    let stage_str = stage.to_string();
                    let output_str = match dir.to_str() {
                        Some(s) => s.to_string(),
                        None => {
                            eprintln!("[mikup] Project dir path is not UTF-8");
                            proxy.emit(AppEvent::SwitchView(ViewState::Workspace)).ok();
                            return;
                        }
                    };

                    // Find original source file from payload
                    let payload_path = dir.join("mikup_payload.json");
                    let input_str = match std::fs::read(&payload_path)
                        .ok()
                        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
                        .and_then(|v| v["metadata"]["source_file"].as_str().map(String::from))
                    {
                        Some(s) => s,
                        None => {
                            eprintln!("[mikup] Cannot read source_file from payload");
                            proxy.emit(AppEvent::SwitchView(ViewState::Workspace)).ok();
                            return;
                        }
                    };

                    let mut child = match std::process::Command::new(&python_bin)
                        .args([
                            "-m", "src.main",
                            "--input", input_str.as_str(),
                            "--output-dir", output_str.as_str(),
                            "--redo-stage", stage_str.as_str(),
                        ])
                        .current_dir(&project_root)
                        .stdout(std::process::Stdio::piped())
                        .stderr(std::process::Stdio::inherit())
                        .spawn()
                    {
                        Ok(c) => c,
                        Err(e) => {
                            eprintln!("[mikup] Failed to spawn redo pipeline: {e}");
                            proxy.emit(AppEvent::SwitchView(ViewState::Workspace)).ok();
                            return;
                        }
                    };

                    let stdout = child.stdout.take().expect("stdout must be piped");
                    {
                        use std::io::BufRead;
                        let reader = std::io::BufReader::new(stdout);
                        for line in reader.lines().map_while(Result::ok) {
                            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) {
                                if val.get("type").and_then(|t| t.as_str()) == Some("progress") {
                                    let progress = val.get("progress")
                                        .and_then(|p| p.as_f64())
                                        .unwrap_or(0.0) as f32;
                                    let message = val.get("message")
                                        .and_then(|m| m.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    proxy.emit(AppEvent::PipelineProgress(progress, message)).ok();
                                }
                            }
                        }
                    }

                    match child.wait() {
                        Ok(s) if s.success() => {
                            proxy.emit(AppEvent::LoadProject(payload_path)).ok();
                        }
                        Ok(s) => {
                            eprintln!("[mikup] Redo pipeline exited {}", s.code().unwrap_or(-1));
                            proxy.emit(AppEvent::SwitchView(ViewState::Workspace)).ok();
                        }
                        Err(e) => {
                            eprintln!("[mikup] Redo pipeline wait error: {e}");
                            proxy.emit(AppEvent::SwitchView(ViewState::Workspace)).ok();
                        }
                    }
                });
            }
            AppEvent::RefreshStorage => {
                let dir = self.project_dir.clone();
                cx.spawn(move |proxy| {
                    let Some(dir) = dir else { return };
                    let usage = crate::project::get_disk_usage(&dir);
                    let available = crate::project::get_available_disk_space(&dir);
                    let total = crate::project::get_total_disk_space(&dir);
                    proxy.emit(AppEvent::StorageUpdate { usage, available, total }).ok();
                });
            }
            other => self.apply_event(other),
        });
    }
}

// ── Engine telemetry (60 Hz) ──────────────────────────────────────────────────

#[derive(Lens, Clone)]
pub struct AudioEngineStore {
    pub playhead_ms: u64,
    pub master_lufs: f32,
    pub master_peak_dbtp: f32,
    pub master_transient_density: f32,
    pub dialogue_spectral_entropy: f32,
    pub masking_intensity: f32,
}

/// Zero-allocation telemetry snapshot.  All fields are `Copy`; spatial data
/// lives exclusively in `VectorscopeData` (shared via `Arc<Mutex>`).
#[derive(Debug, Clone, Copy)]
pub struct AudioEngineStoreUpdate {
    pub playhead_ms: u64,
    pub master_lufs: f32,
    pub master_peak_dbtp: f32,
    pub master_transient_density: f32,
    pub dialogue_spectral_entropy: f32,
    pub masking_intensity: f32,
}

impl Model for AudioEngineStore {
    fn event(&mut self, _cx: &mut EventContext, event: &mut Event) {
        event.map(|u: &AudioEngineStoreUpdate, _meta| {
            self.playhead_ms = u.playhead_ms;
            self.master_lufs = u.master_lufs;
            self.master_peak_dbtp = u.master_peak_dbtp;
            self.master_transient_density = u.master_transient_density;
            self.dialogue_spectral_entropy = u.dialogue_spectral_entropy;
            self.masking_intensity = u.masking_intensity;
        });
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_appdata() -> AppData {
        AppData {
            volume: 1.0,
            playing: false,
            seek_sensitivity: 1.0,
            is_scrubbing: false,
            project_name: String::new(),
            current_view: ViewState::Landing,
            available_projects: Vec::new(),
            transcript_segments: Vec::new(),
            word_segments: Vec::new(),
            loaded_project: MaybeProject(None),
            engine: None,
            vectorscope_data: Arc::new(Mutex::new(VectorscopeData::default())),
            pipeline_progress: 0.0,
            pipeline_message: String::new(),
            project_disk_usage: 0,
            system_available_space: 0,
            system_total_space: 0,
            project_dir: None,
        }
    }

    #[test]
    fn toggle_play_flips_state() {
        let mut data = make_appdata();
        data.apply_event(AppEvent::TogglePlay);
        assert!(data.playing);
        data.apply_event(AppEvent::TogglePlay);
        assert!(!data.playing);
    }

    #[test]
    fn set_volume_clamps_to_zero_one() {
        let mut data = make_appdata();
        data.volume = 0.5;
        data.apply_event(AppEvent::SetVolume(1.5));
        assert_eq!(data.volume, 1.0);
        data.apply_event(AppEvent::SetVolume(-0.1));
        assert_eq!(data.volume, 0.0);
    }

    #[test]
    fn set_seek_sensitivity_clamps_to_supported_range() {
        let mut data = make_appdata();
        data.apply_event(AppEvent::SetSeekSensitivity(12.0));
        assert_eq!(data.seek_sensitivity, 10.0);
        data.apply_event(AppEvent::SetSeekSensitivity(0.05));
        assert_eq!(data.seek_sensitivity, 0.1);
    }

    #[test]
    fn scrubbing_events_flip_flag() {
        let mut data = make_appdata();
        data.apply_event(AppEvent::StartScrubbing);
        assert!(data.is_scrubbing);
        data.apply_event(AppEvent::StopScrubbing);
        assert!(!data.is_scrubbing);
    }

    #[test]
    fn project_ready_updates_loaded_project_and_view() {
        let mut data = make_appdata();
        data.current_view = ViewState::Processing;
        let assets = Arc::new(WorkspaceAssets {
            master_waveform: Arc::new(vec![]),
            dx_waveform: Arc::new(vec![]),
            music_waveform: Arc::new(vec![]),
            effects_waveform: Arc::new(vec![]),
            lufs_samples: Arc::new(vec![]),
            master_lufs: Arc::new(vec![]),
            pacing_density: Arc::new(vec![]),
            transcript_items: Arc::new(vec![]),
            forensic_markers: Arc::new(vec![]),
            total_duration_ms: 0,
        });
        data.apply_event(AppEvent::ProjectReady(Arc::clone(&assets)));
        assert!(data.loaded_project.0.is_some());
        assert_eq!(data.current_view, ViewState::Workspace);
    }
}
