use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use rfd::FileDialog;
use vizia::prelude::*;

use crate::audio_engine::{AudioCmd, AudioController};
use crate::project::{Project, TranscriptSegment, WordSegment};
use crate::vectorscope_view::VectorscopeData;

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

// ── Workspace assets ──────────────────────────────────────────────────────────

/// Arc-based bundle of all data the workspace view needs.
/// All fields are cheap-clone Arcs; the struct is `Send` so it can be built
/// on a background thread and sent back via `ContextProxy::emit`.
#[derive(Clone)]
pub struct WorkspaceAssets {
    pub dx_samples: Arc<Vec<f32>>,
    pub music_samples: Arc<Vec<f32>>,
    pub effects_samples: Arc<Vec<f32>>,
    pub transcript_items: Arc<Vec<(String, u64)>>,
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
}

#[derive(Clone)]
pub enum AppEvent {
    TogglePlay,
    SetVolume(f32),
    SeekTo(u64),
    LoadProject(PathBuf),
    SelectNewAudioFile,
    StartPipeline(PathBuf),
    ProjectReady(Arc<WorkspaceAssets>),
    SwitchView(ViewState),
    PipelineProgress(f32, String),
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
            AppEvent::ProjectReady(assets) => {
                self.loaded_project = MaybeProject(Some(assets));
                self.current_view = ViewState::Workspace;
            }
            AppEvent::SwitchView(v) => {
                self.current_view = v;
            }
            AppEvent::PipelineProgress(pct, msg) => {
                self.pipeline_progress = pct;
                self.pipeline_message = msg;
            }
            // Handled in Model::event (needs cx).
            AppEvent::LoadProject(_) | AppEvent::SelectNewAudioFile | AppEvent::StartPipeline(_) => {}
        }
    }
}

impl Model for AppData {
    fn event(&mut self, cx: &mut EventContext, event: &mut Event) {
        event.map(|e: &AppEvent, _meta| match e.clone() {
            AppEvent::LoadProject(path) => {
                self.current_view = ViewState::Processing;
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
                        let assets = Arc::new(WorkspaceAssets {
                            dx_samples: Arc::new(proj.stems.dx_samples),
                            music_samples: Arc::new(proj.stems.music_samples),
                            effects_samples: Arc::new(proj.stems.effects_samples),
                            transcript_items: Arc::new(transcript_items),
                        });
                        proxy.emit(AppEvent::ProjectReady(assets)).ok();
                    }
                    Err(e) => eprintln!("[mikup] LoadProject failed: {e}"),
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

                    let mut child = match std::process::Command::new("python3")
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
                            eprintln!("[mikup] Failed to spawn python3: {e}");
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
            other => self.apply_event(other),
        });
    }
}

// ── Engine telemetry (60 Hz) ──────────────────────────────────────────────────

#[derive(Lens, Clone)]
pub struct AudioEngineStore {
    pub playhead_ms: u64,
    pub dx_lufs: f32,
    pub music_lufs: f32,
    pub effects_lufs: f32,
    pub dx_peak_dbtp: f32,
    pub music_peak_dbtp: f32,
    pub effects_peak_dbtp: f32,
}

/// Zero-allocation telemetry snapshot.  All fields are `Copy`; spatial data
/// lives exclusively in `VectorscopeData` (shared via `Arc<Mutex>`).
#[derive(Debug, Clone, Copy)]
pub struct AudioEngineStoreUpdate {
    pub playhead_ms: u64,
    pub dx_lufs: f32,
    pub music_lufs: f32,
    pub effects_lufs: f32,
    pub dx_peak_dbtp: f32,
    pub music_peak_dbtp: f32,
    pub effects_peak_dbtp: f32,
}

impl Model for AudioEngineStore {
    fn event(&mut self, _cx: &mut EventContext, event: &mut Event) {
        event.map(|u: &AudioEngineStoreUpdate, _meta| {
            self.playhead_ms = u.playhead_ms;
            self.dx_lufs = u.dx_lufs;
            self.music_lufs = u.music_lufs;
            self.effects_lufs = u.effects_lufs;
            self.dx_peak_dbtp = u.dx_peak_dbtp;
            self.music_peak_dbtp = u.music_peak_dbtp;
            self.effects_peak_dbtp = u.effects_peak_dbtp;
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
    fn project_ready_updates_loaded_project_and_view() {
        let mut data = make_appdata();
        data.current_view = ViewState::Processing;
        let assets = Arc::new(WorkspaceAssets {
            dx_samples: Arc::new(vec![]),
            music_samples: Arc::new(vec![]),
            effects_samples: Arc::new(vec![]),
            transcript_items: Arc::new(vec![]),
        });
        data.apply_event(AppEvent::ProjectReady(Arc::clone(&assets)));
        assert!(data.loaded_project.0.is_some());
        assert_eq!(data.current_view, ViewState::Workspace);
    }
}
