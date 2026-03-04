mod audio_engine;
mod dsp;
mod landing_view;
mod lufs_meter;
mod models;
mod project;
mod vectorscope_view;
mod waveform_view;
mod workspace_view;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use vizia::prelude::*;
use vizia::style::Color;

use audio_engine::AudioController;
use models::{
    AppData, AudioEngineStore, AudioEngineStoreUpdate, MaybeProject, ProjectMetadata, ViewState,
    WorkspaceAssets,
};
use project::Project;
use vectorscope_view::VectorscopeData;

fn main() {
    let config = project::load_config();
    let mut available_projects = project::scan_projects_folder(config.default_projects_dir.clone());

    let payload_path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "mikup_payload.json".to_string());

    let project = match Project::load(&payload_path) {
        Ok(p) => {
            eprintln!(
                "[mikup] Loaded project: {} ({} DX samples, {} Music, {} FX)",
                p.payload.metadata.source_file,
                p.stems.dx_samples.len(),
                p.stems.music_samples.len(),
                p.stems.effects_samples.len(),
            );
            Some(p)
        }
        Err(e) => {
            eprintln!("[mikup] Failed to load project: {e}");
            eprintln!("[mikup] Usage: mikup-native <path/to/mikup_payload.json>");
            eprintln!("[mikup] Starting with empty project.");
            None
        }
    };

    let hw_rate = audio_engine::detect_hw_rate();

    let dx_samples = project
        .as_ref()
        .map(|p| p.stems.dx_samples.clone())
        .unwrap_or_default();
    let music_samples = project
        .as_ref()
        .map(|p| p.stems.music_samples.clone())
        .unwrap_or_default();
    let effects_samples = project
        .as_ref()
        .map(|p| p.stems.effects_samples.clone())
        .unwrap_or_default();

    let transcript_segments = project
        .as_ref()
        .map(|p| p.payload.transcription.segments.clone())
        .unwrap_or_default();
    let word_segments = project
        .as_ref()
        .map(|p| p.payload.transcription.word_segments.clone())
        .unwrap_or_default();
    let project_name = project
        .as_ref()
        .map(|p| p.payload.metadata.source_file.clone())
        .unwrap_or_else(|| "(no project)".to_string());

    if let Some(ref proj) = project {
        let workspace_path = std::path::PathBuf::from(&payload_path)
            .parent()
            .map_or_else(std::path::PathBuf::new, std::path::Path::to_path_buf);
        let exists = available_projects
            .iter()
            .any(|meta| meta.workspace_path == workspace_path);
        if !exists {
            available_projects.push(ProjectMetadata {
                name: workspace_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or(&proj.payload.metadata.source_file)
                    .to_string(),
                timestamp: chrono::Utc::now(),
                source_path: proj.stems.dx_path.clone(),
                workspace_path,
                version: proj.payload.metadata.pipeline_version.clone(),
            });
        }
    }

    let engine = if let Some(ref proj) = project {
        Arc::new(Mutex::new(AudioController::new(
            hw_rate,
            proj.stems.dx_path.clone(),
            proj.stems.music_path.clone(),
            proj.stems.effects_path.clone(),
        )))
    } else {
        let empty = std::path::PathBuf::from("/dev/null");
        Arc::new(Mutex::new(AudioController::new(
            hw_rate,
            empty.clone(),
            empty.clone(),
            empty,
        )))
    };

    // Start in Workspace if a project was given on the CLI, Landing otherwise.
    let initial_view = if project.is_some() {
        ViewState::Workspace
    } else {
        ViewState::Landing
    };

    let transcript_items: Vec<(String, u64)> = transcript_segments
        .iter()
        .map(|s| {
            (
                format!("[{:.1}s] {}: {}", s.start, s.speaker, s.text),
                (s.start * 1000.0) as u64,
            )
        })
        .collect();

    let engine_for_timer = Arc::clone(&engine);
    let engine_for_appdata = Arc::clone(&engine);

    let scope_data = Arc::new(Mutex::new(VectorscopeData::default()));
    let scope_for_timer = Arc::clone(&scope_data);
    let scope_for_appdata = Arc::clone(&scope_data);
    let scope_for_ws = Arc::clone(&scope_data);

    // All workspace data behind a single Arc; shared with AppData.loaded_project
    // and the 60 Hz timer (scope_for_timer points into the same scope Arc).
    let initial_assets = MaybeProject(if project.is_some() {
        Some(Arc::new(WorkspaceAssets {
            dx_samples: Arc::new(dx_samples),
            music_samples: Arc::new(music_samples),
            effects_samples: Arc::new(effects_samples),
            transcript_items: Arc::new(transcript_items),
        }))
    } else {
        None
    });

    Application::new(move |cx| {
        AppData {
            volume: 1.0,
            playing: false,
            project_name: project_name.clone(),
            current_view: initial_view.clone(),
            available_projects: available_projects.clone(),
            transcript_segments: transcript_segments.clone(),
            word_segments: word_segments.clone(),
            loaded_project: initial_assets.clone(),
            engine: Some(engine_for_appdata),
            vectorscope_data: scope_for_appdata,
            pipeline_progress: 0.0,
            pipeline_message: String::new(),
        }
        .build(cx);

        AudioEngineStore {
            playhead_ms: 0,
            dx_lufs: -70.0,
            music_lufs: -70.0,
            effects_lufs: -70.0,
            dx_peak_dbtp: -120.0,
            music_peak_dbtp: -120.0,
            effects_peak_dbtp: -120.0,
        }
        .build(cx);

        // 60 Hz telemetry poll.
        let timer = cx.add_timer(Duration::from_nanos(16_666_667), None, move |cx, action| {
            if let TimerAction::Tick(_) = action {
                let mut eng = engine_for_timer.lock().unwrap();
                let mut latest = None;
                while let Ok(t) = eng.telemetry_rx.pop() {
                    latest = Some(t);
                }
                if let Some(t) = latest {
                    let n = t.spatial_point_count as usize * 2;
                    let xy_slice = &t.spatial_xy[..n];
                    {
                        let mut sd = scope_for_timer.lock().unwrap();
                        sd.points.clear();
                        sd.points.extend_from_slice(xy_slice);
                        sd.correlation = t.phase_correlation;
                    }
                    cx.emit(AudioEngineStoreUpdate {
                        playhead_ms: t.playhead_ms,
                        dx_lufs: t.dx_lufs,
                        music_lufs: t.music_lufs,
                        effects_lufs: t.effects_lufs,
                        dx_peak_dbtp: t.dx_peak_dbtp,
                        music_peak_dbtp: t.music_peak_dbtp,
                        effects_peak_dbtp: t.effects_peak_dbtp,
                    });
                }
            }
        });
        cx.start_timer(timer);

        // ── View switcher ─────────────────────────────────────────────────────
        Binding::new(
            cx,
            AppData::current_view,
            move |cx, view_lens| {
                let scope = scope_for_ws.clone();
                match view_lens.get(cx) {
                    ViewState::Landing => {
                        let projs = AppData::available_projects.get(cx);
                        landing_view::build(cx, projs);
                    }
                    ViewState::Processing => {
                        VStack::new(cx, |cx| {
                            Label::new(cx, "Processing…").color(Color::rgb(180, 180, 200));
                        })
                        .width(Stretch(1.0))
                        .height(Stretch(1.0))
                        .background_color(Color::rgb(30, 30, 30));
                    }
                    ViewState::Workspace => {
                        Binding::new(cx, AppData::loaded_project, move |cx, proj_lens| {
                            if let Some(assets) = proj_lens.get(cx).0 {
                                workspace_view::build(cx, &assets, scope.clone());
                            }
                        });
                    }
                }
            },
        );
    })
    .title("Mikup Native")
    .inner_size((1400, 600))
    .run()
    .expect("Vizia application error");
}
