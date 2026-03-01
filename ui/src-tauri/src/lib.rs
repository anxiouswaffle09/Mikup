use chrono::Local;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use crate::dsp::loudness::LoudnessAnalyzer;
use crate::dsp::player::{interleave_mono, AudioOutputPlayer, MonoResampler};
use crate::dsp::scanner::{OfflineLoudnessScanner, ScanEvent};
use crate::dsp::spatial::SpatialAnalyzer;
use crate::dsp::spectral::SpectralAnalyzer;
use crate::dsp::{shared_default_stem_states, MikupAudioDecoder, StemState};

pub mod dsp;

const DSP_FRAME_SIZE: usize = 2048;
const DSP_SAMPLE_RATE: u32 = 48_000;
/// Maximum Lissajous points to send per frame (subsampled from the raw 2048-sample frame).
const LISSAJOUS_MAX_POINTS: usize = 128;
/// Minimum wall-clock interval between emitted frames; guards against render-cycle flooding
/// if a caller ever uses a smaller frame size than the default 2048/48kHz (~42 ms/frame).
const MIN_EMIT_INTERVAL_MS: u64 = 16;

#[derive(Clone, serde::Serialize)]
struct ProgressPayload {
    stage: String,
    progress: u32,
    message: String,
}

/// Per-frame payload streamed via the `dsp-frame` Tauri event.
/// All float fields use f32 for compact JSON; the frontend rounds as needed.
#[derive(Clone, serde::Serialize)]
struct DspFramePayload {
    /// Monotonic counter (1-based) of frames processed so far.
    frame_index: u64,
    /// Elapsed time in seconds at the start of this frame.
    timestamp_secs: f32,
    // --- Loudness (dialogue stem) ---
    dialogue_momentary_lufs: f32,
    dialogue_short_term_lufs: f32,
    dialogue_true_peak_dbtp: f32,
    dialogue_crest_factor: f32,
    // --- Loudness (background stem) ---
    background_momentary_lufs: f32,
    background_short_term_lufs: f32,
    background_true_peak_dbtp: f32,
    background_crest_factor: f32,
    // --- Spatial ---
    phase_correlation: f32,
    /// Subsampled Lissajous coordinates [[x, y], ...] for vectorscope rendering.
    lissajous_points: Vec<[f32; 2]>,
    // --- Spectral ---
    dialogue_centroid_hz: f32,
    background_centroid_hz: f32,
    speech_pocket_masked: bool,
    dialogue_speech_energy: f32,
    background_speech_energy: f32,
    snr_db: f32,
}

/// Emitted once via `dsp-complete` when the decoder naturally reaches EOF.
/// Contains integrated (whole-file) metrics suitable for writing to mikup_payload.json.
#[derive(Clone, serde::Serialize)]
struct DspCompletePayload {
    total_frames: u64,
    dialogue_integrated_lufs: f32,
    dialogue_loudness_range_lu: f32,
    background_integrated_lufs: f32,
    background_loudness_range_lu: f32,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct AppConfig {
    default_projects_dir: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            default_projects_dir: String::new(),
        }
    }
}

#[derive(Clone, serde::Serialize)]
struct WorkspaceSetupResult {
    workspace_dir: String,
    copied_input_path: String,
}

fn contains_unsafe_shell_tokens(value: &str) -> bool {
    value.contains('`') || value.contains('\n') || value.contains('\r')
}

fn ensure_safe_argument(name: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{name} must not be empty"));
    }
    if contains_unsafe_shell_tokens(value) {
        return Err(format!(
            "{name} contains disallowed shell operator characters"
        ));
    }
    Ok(())
}

fn find_project_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(current_dir);
    }
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            candidates.push(exe_dir.to_path_buf());
        }
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir);
    }

    let mut visited = HashSet::new();
    for candidate in candidates {
        for ancestor in candidate.ancestors() {
            let ancestor_path = ancestor.to_path_buf();
            if !visited.insert(ancestor_path.clone()) {
                continue;
            }
            if ancestor_path.join("src/main.py").is_file() && ancestor_path.join("data").is_dir() {
                return Some(ancestor_path);
            }
        }
    }

    None
}

fn resolve_python_path(project_root: &Path) -> String {
    let unix_python = project_root.join(".venv").join("bin").join("python3");
    if unix_python.is_file() {
        return unix_python.to_string_lossy().into_owned();
    }
    let windows_python = project_root
        .join(".venv")
        .join("Scripts")
        .join("python.exe");
    if windows_python.is_file() {
        return windows_python.to_string_lossy().into_owned();
    }
    "python3".to_string()
}

fn resolve_output_paths(
    output_directory: &str,
) -> Result<(PathBuf, String, PathBuf, String), String> {
    ensure_safe_argument("Output directory", output_directory)?;
    let output_directory_path = PathBuf::from(output_directory);
    if !output_directory_path.is_absolute() {
        return Err("Output directory must be an absolute path".to_string());
    }
    let output_directory_arg = output_directory_path.to_string_lossy().into_owned();
    ensure_safe_argument("Output directory", &output_directory_arg)?;

    let output_path = output_directory_path.join("mikup_payload.json");
    let output_path_arg = output_path.to_string_lossy().into_owned();
    ensure_safe_argument("Resolved output path", &output_path_arg)?;

    Ok((
        output_directory_path,
        output_directory_arg,
        output_path,
        output_path_arg,
    ))
}

fn resolve_data_artifact_path(output_directory: &str, file_name: &str) -> Result<PathBuf, String> {
    ensure_safe_argument("Output directory", output_directory)?;
    Ok(PathBuf::from(output_directory).join("data").join(file_name))
}

fn app_config_path(project_root: &Path) -> PathBuf {
    project_root.join("data").join("config.json")
}

fn build_base_pipeline_args(
    input_path_arg: &str,
    output_directory_arg: &str,
    output_path_arg: &str,
) -> Vec<String> {
    vec![
        "-m".to_string(),
        "src.main".to_string(),
        "--input".to_string(),
        input_path_arg.to_string(),
        "--output-dir".to_string(),
        output_directory_arg.to_string(),
        "--output".to_string(),
        output_path_arg.to_string(),
    ]
}

async fn run_python_pipeline(
    app: &tauri::AppHandle,
    project_root: &Path,
    args: Vec<String>,
    timeout_secs: u64,
) -> Result<(), String> {
    let python_path = resolve_python_path(project_root);
    let (mut rx, _child) = app
        .shell()
        .command(&python_path)
        .current_dir(project_root)
        .args(args)
        .spawn()
        .map_err(|e| e.to_string())?;

    let mut stdout_buf = String::new();
    let mut clean_exit = false;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let maybe_event = tokio::time::timeout(remaining, rx.recv())
            .await
            .map_err(|_| format!("Pipeline timed out after {timeout_secs} seconds"))?;

        match maybe_event {
            Some(CommandEvent::Stdout(chunk)) => {
                stdout_buf.push_str(&String::from_utf8_lossy(&chunk));
                while let Some(pos) = stdout_buf.find('\n') {
                    let line: String = stdout_buf.drain(..=pos).collect();
                    let trimmed = line.trim_end_matches('\n').trim_end_matches('\r');
                    if let Ok(json_val) = serde_json::from_str::<serde_json::Value>(trimmed) {
                        if json_val["type"] == "progress" {
                            let _ = app.emit(
                                "process-status",
                                ProgressPayload {
                                    stage: json_val["stage"].as_str().unwrap_or("").to_string(),
                                    progress: json_val["progress"].as_u64().unwrap_or(0) as u32,
                                    message: json_val["message"].as_str().unwrap_or("").to_string(),
                                },
                            );
                        }
                    }
                }
            }
            Some(CommandEvent::Stderr(line)) => {
                let msg = String::from_utf8_lossy(&line).to_string();
                eprintln!("Python Error: {}", msg);
                let _ = app.emit("process-error", msg);
            }
            Some(CommandEvent::Terminated(status)) => {
                if status.code != Some(0) {
                    return Err(format!("Pipeline failed with exit code {:?}", status.code));
                }
                clean_exit = true;
                break;
            }
            Some(_) => {}
            None => break,
        }
    }

    if !clean_exit {
        return Err("Pipeline terminated unexpectedly".to_string());
    }

    Ok(())
}

#[tauri::command]
async fn get_history(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let project_root =
        find_project_root(&app).ok_or_else(|| "Unable to resolve project root".to_string())?;
    let history_path = project_root.join("data/history.json");

    if !history_path.exists() {
        return Ok(serde_json::Value::Array(vec![]));
    }

    let content = tokio::fs::read_to_string(history_path)
        .await
        .map_err(|e| e.to_string())?;
    let history: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(history)
}

#[tauri::command]
async fn get_app_config(app: tauri::AppHandle) -> Result<AppConfig, String> {
    let project_root =
        find_project_root(&app).ok_or_else(|| "Unable to resolve project root".to_string())?;
    let config_path = app_config_path(&project_root);

    let content = match tokio::fs::read_to_string(config_path).await {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(AppConfig::default()),
        Err(e) => return Err(format!("Failed to read app config: {e}")),
    };

    serde_json::from_str::<AppConfig>(&content).map_err(|e| format!("Invalid app config JSON: {e}"))
}

#[tauri::command]
async fn set_default_projects_dir(
    app: tauri::AppHandle,
    path: String,
) -> Result<AppConfig, String> {
    ensure_safe_argument("Default projects directory", &path)?;
    let project_root =
        find_project_root(&app).ok_or_else(|| "Unable to resolve project root".to_string())?;

    let config_path = app_config_path(&project_root);
    let config_dir = config_path
        .parent()
        .ok_or_else(|| "Invalid app config path".to_string())?;
    tokio::fs::create_dir_all(config_dir)
        .await
        .map_err(|e| format!("Failed to create config directory: {e}"))?;

    let normalized_path = PathBuf::from(path).to_string_lossy().into_owned();
    let config = AppConfig {
        default_projects_dir: normalized_path,
    };
    let serialized = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {e}"))?;
    tokio::fs::write(config_path, serialized)
        .await
        .map_err(|e| format!("Failed to write app config: {e}"))?;

    Ok(config)
}

#[tauri::command]
async fn setup_project_workspace(
    input_path: String,
    base_directory: String,
) -> Result<WorkspaceSetupResult, String> {
    ensure_safe_argument("Input path", &input_path)?;
    ensure_safe_argument("Base directory", &base_directory)?;

    let base_dir_path = PathBuf::from(&base_directory);
    if !base_dir_path.is_absolute() {
        return Err("Base directory must be an absolute path".to_string());
    }

    let input_file = PathBuf::from(&input_path);
    if !input_file.is_file() {
        return Err(format!("Input file not found: {input_path}"));
    }

    let file_stem = input_file
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "Failed to extract file stem from input path".to_string())?;
    let timestamp = Local::now().format("%Y%m%d_%H%M%S").to_string();
    let workspace_name = format!("{file_stem}_{timestamp}");
    let workspace_dir = PathBuf::from(base_directory).join(workspace_name);
    let data_dir = workspace_dir.join("data");
    let stems_dir = workspace_dir.join("stems");

    tokio::fs::create_dir_all(&data_dir)
        .await
        .map_err(|e| format!("Failed to create workspace data directory: {e}"))?;
    tokio::fs::create_dir_all(&stems_dir)
        .await
        .map_err(|e| format!("Failed to create workspace stems directory: {e}"))?;

    let input_file_name = input_file
        .file_name()
        .ok_or_else(|| "Failed to extract input filename".to_string())?;
    let copied_input_path = workspace_dir.join(input_file_name);
    tokio::fs::copy(&input_file, &copied_input_path)
        .await
        .map_err(|e| format!("Failed to copy source audio into workspace: {e}"))?;

    Ok(WorkspaceSetupResult {
        workspace_dir: workspace_dir.to_string_lossy().into_owned(),
        copied_input_path: copied_input_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
async fn process_audio(
    app: tauri::AppHandle,
    input_path: String,
    output_directory: String,
) -> Result<String, String> {
    ensure_safe_argument("Input path", &input_path)?;

    let project_root =
        find_project_root(&app).ok_or_else(|| "Unable to resolve project root".to_string())?;
    let (output_directory_path, output_directory_arg, output_path, output_path_arg) =
        resolve_output_paths(&output_directory)?;
    tokio::fs::create_dir_all(&output_directory_path)
        .await
        .map_err(|e| format!("Failed to create output directory: {e}"))?;

    let input_path_arg = PathBuf::from(input_path).to_string_lossy().into_owned();
    ensure_safe_argument("Input path", &input_path_arg)?;
    let args = build_base_pipeline_args(&input_path_arg, &output_directory_arg, &output_path_arg);

    run_python_pipeline(&app, &project_root, args, 600).await?;

    let payload = tokio::fs::read_to_string(output_path)
        .await
        .map_err(|e| format!("Failed to read payload: {}", e))?;

    Ok(payload)
}

#[tauri::command]
async fn run_pipeline_stage(
    app: tauri::AppHandle,
    input_path: String,
    output_directory: String,
    stage: String,
    fast_mode: Option<bool>,
    force: Option<bool>,
) -> Result<String, String> {
    ensure_safe_argument("Input path", &input_path)?;
    ensure_safe_argument("Stage", &stage)?;

    let project_root =
        find_project_root(&app).ok_or_else(|| "Unable to resolve project root".to_string())?;
    let (output_directory_path, output_directory_arg, _output_path, output_path_arg) =
        resolve_output_paths(&output_directory)?;
    tokio::fs::create_dir_all(&output_directory_path)
        .await
        .map_err(|e| format!("Failed to create output directory: {e}"))?;

    let input_path_arg = PathBuf::from(input_path).to_string_lossy().into_owned();
    ensure_safe_argument("Input path", &input_path_arg)?;
    let stage_arg = stage.trim().to_ascii_lowercase();
    let valid_stage = matches!(
        stage_arg.as_str(),
        "separation" | "transcription" | "dsp" | "semantics" | "director"
    );
    if !valid_stage {
        return Err(format!(
            "Invalid stage '{}'. Allowed stages: separation, transcription, dsp, semantics, director",
            stage
        ));
    }

    let mut args =
        build_base_pipeline_args(&input_path_arg, &output_directory_arg, &output_path_arg);
    args.extend(["--stage".to_string(), stage_arg.clone()]);
    if fast_mode.unwrap_or(false) {
        args.push("--fast".to_string());
    }
    if force.unwrap_or(false) {
        args.push("--force".to_string());
    }

    run_python_pipeline(&app, &project_root, args, 1200).await?;
    Ok(format!("Stage {stage_arg} completed"))
}

#[tauri::command]
async fn read_output_payload(output_directory: String) -> Result<String, String> {
    let (_output_directory_path, _output_directory_arg, output_path, _output_path_arg) =
        resolve_output_paths(&output_directory)?;
    tokio::fs::read_to_string(output_path)
        .await
        .map_err(|e| format!("Failed to read payload: {e}"))
}

#[tauri::command]
async fn get_stems(output_directory: String) -> Result<serde_json::Value, String> {
    let stems_path = resolve_data_artifact_path(&output_directory, "stems.json")?;

    if !stems_path.exists() {
        return Err(format!("stems.json not found at {}", stems_path.display()));
    }

    let content = tokio::fs::read_to_string(&stems_path)
        .await
        .map_err(|e| format!("Failed to read stems.json: {e}"))?;

    serde_json::from_str(&content).map_err(|e| format!("Invalid JSON in stems.json: {e}"))
}

#[tauri::command]
async fn get_pipeline_state(output_directory: String) -> Result<u32, String> {
    let state_path = resolve_data_artifact_path(&output_directory, "stage_state.json")?;

    let content = match tokio::fs::read_to_string(&state_path).await {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e.to_string()),
    };

    let state: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return Ok(0),
    };

    let stages_map = match state.get("stages").and_then(|s| s.as_object()) {
        Some(m) => m,
        None => return Ok(0),
    };

    let canonical_order = [
        "separation",
        "transcription",
        "dsp",
        "semantics",
        "director",
    ];
    let mut count = 0u32;
    for stage_name in canonical_order.iter() {
        let completed = stages_map
            .get(*stage_name)
            .and_then(|s| s.get("completed"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if completed {
            count += 1;
        } else {
            break; // stop at first gap — no holes allowed
        }
    }

    Ok(count)
}

/// Persist the integrated LUFS and LRA produced by `stream_audio_metrics` to disk.
/// Written to `{output_directory}/data/dsp_metrics.json` so the Python backend can
/// read it during Stage 5 (AI Director report generation).
#[tauri::command]
async fn write_dsp_metrics(
    output_directory: String,
    dialogue_integrated_lufs: f32,
    dialogue_loudness_range_lu: f32,
    background_integrated_lufs: f32,
    background_loudness_range_lu: f32,
) -> Result<(), String> {
    let metrics_path = resolve_data_artifact_path(&output_directory, "dsp_metrics.json")?;

    let metrics = serde_json::json!({
        "dialogue_integrated_lufs": dialogue_integrated_lufs,
        "dialogue_loudness_range_lu": dialogue_loudness_range_lu,
        "background_integrated_lufs": background_integrated_lufs,
        "background_loudness_range_lu": background_loudness_range_lu,
    });

    let serialized = serde_json::to_string_pretty(&metrics).map_err(|e| e.to_string())?;

    // Ensure the data directory exists (workspace setup normally creates it, but be safe).
    if let Some(parent) = metrics_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create data directory: {e}"))?;
    }

    tokio::fs::write(&metrics_path, serialized)
        .await
        .map_err(|e| format!("Failed to write dsp_metrics.json: {e}"))
}

/// Build a static LUFS map offline using fast Rust decoding + EBU R128, then persist to disk.
///
/// The returned JSON is shaped as `{ "lufs_graph": { ... } }` so callers can merge it into
/// `payload.metrics`. We additionally persist compatibility flat fields in `dsp_metrics.json`
/// so existing Stage 5 readers can continue reading integrated LUFS values.
#[tauri::command]
async fn generate_static_map(
    app: tauri::AppHandle,
    output_directory: String,
    stem_paths: HashMap<String, String>,
) -> Result<serde_json::Value, String> {
    ensure_safe_argument("Output directory", &output_directory)?;
    let output_path = PathBuf::from(&output_directory);
    if !output_path.is_absolute() {
        return Err("Output directory must be an absolute path".to_string());
    }

    for (stem, path) in &stem_paths {
        ensure_safe_argument(&format!("Stem key ({stem})"), stem)?;
        ensure_safe_argument(&format!("Stem path ({stem})"), path)?;
    }

    let app_handle = app.clone();
    let output_directory_for_write = output_directory.clone();
    let scan_result = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let scanner = OfflineLoudnessScanner::new(2).map_err(|e| e.to_string())?;
        let resolved = OfflineLoudnessScanner::resolve_required_stems(&stem_paths)
            .map_err(|e| e.to_string())?;

        let mut completed_stems = 0_u32;
        let profiles = scanner
            .scan(resolved, |event| match event {
                ScanEvent::StemStarted { stem } => {
                    let _ = app_handle.emit(
                        "process-status",
                        ProgressPayload {
                            stage: "DSP".to_string(),
                            progress: (completed_stems * 100 / 5).min(99),
                            message: format!("Turbo Scan: scanning {stem} stem..."),
                        },
                    );
                }
                ScanEvent::StemProgress {
                    stem,
                    seconds_scanned,
                } => {
                    let _ = app_handle.emit(
                        "process-status",
                        ProgressPayload {
                            stage: "DSP".to_string(),
                            progress: (completed_stems * 100 / 5).min(99),
                            message: format!(
                                "Turbo Scan: {stem} scanned {:.1}s ({} of 5 complete)...",
                                seconds_scanned, completed_stems
                            ),
                        },
                    );
                }
                ScanEvent::StemFinished { stem } => {
                    completed_stems += 1;
                    let _ = app_handle.emit(
                        "process-status",
                        ProgressPayload {
                            stage: "DSP".to_string(),
                            progress: (completed_stems * 100 / 5).min(100),
                            message: format!(
                                "Turbo Scan: completed {stem} ({completed_stems} of 5)."
                            ),
                        },
                    );
                }
            })
            .map_err(|e| e.to_string())?;

        let dx = profiles
            .get("DX")
            .ok_or_else(|| "Scanner did not produce DX profile".to_string())?;
        let music = profiles
            .get("Music")
            .ok_or_else(|| "Scanner did not produce Music profile".to_string())?;
        let sfx = profiles
            .get("SFX")
            .ok_or_else(|| "Scanner did not produce SFX profile".to_string())?;
        let foley = profiles
            .get("Foley")
            .ok_or_else(|| "Scanner did not produce Foley profile".to_string())?;
        let ambience = profiles
            .get("Ambience")
            .ok_or_else(|| "Scanner did not produce Ambience profile".to_string())?;

        let lufs_graph = serde_json::json!({
            "DX": dx,
            "Music": music,
            "SFX": sfx,
            "Foley": foley,
            "Ambience": ambience,
            // Backward-compatible aliases consumed by current UI panels.
            "dialogue_raw": dx,
            "background_raw": music,
        });

        let persisted_metrics = serde_json::json!({
            "lufs_graph": lufs_graph,
            "dialogue_integrated_lufs": dx.integrated,
            "dialogue_loudness_range_lu": dx.loudness_range_lu,
            "background_integrated_lufs": music.integrated,
            "background_loudness_range_lu": music.loudness_range_lu,
        });

        let metrics_path = PathBuf::from(output_directory_for_write)
            .join("data")
            .join("dsp_metrics.json");
        if let Some(parent) = metrics_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create data directory: {e}"))?;
        }
        let serialized =
            serde_json::to_string_pretty(&persisted_metrics).map_err(|e| e.to_string())?;
        let tmp_path = metrics_path.with_extension("json.tmp");
        std::fs::write(&tmp_path, &serialized)
            .map_err(|e| format!("Failed to write dsp_metrics.json: {e}"))?;
        std::fs::rename(&tmp_path, &metrics_path)
            .map_err(|e| format!("Failed to finalize dsp_metrics.json: {e}"))?;

        let _ = app_handle.emit(
            "process-status",
            ProgressPayload {
                stage: "DSP".to_string(),
                progress: 100,
                message: "Turbo Scan complete. Static LUFS map generated.".to_string(),
            },
        );

        Ok(serde_json::json!({
            "lufs_graph": persisted_metrics["lufs_graph"].clone(),
        }))
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(scan_result)
}

/// Marks the DSP stage as complete in `stage_state.json`.
/// Called by the frontend after the Rust `stream_audio_metrics` stream ends naturally.
/// This allows `get_pipeline_state` to correctly report 3 completed stages on resume.
#[tauri::command]
async fn mark_dsp_complete(output_directory: String) -> Result<(), String> {
    let state_path = resolve_data_artifact_path(&output_directory, "stage_state.json")?;

    let mut state: serde_json::Value = match tokio::fs::read_to_string(&state_path).await {
        Ok(content) => {
            serde_json::from_str(&content).unwrap_or_else(|_| serde_json::json!({ "stages": {} }))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            serde_json::json!({ "stages": {} })
        }
        Err(e) => return Err(e.to_string()),
    };

    state["stages"]["dsp"] = serde_json::json!({ "completed": true });

    let serialized = serde_json::to_string(&state).map_err(|e| e.to_string())?;
    tokio::fs::write(&state_path, serialized)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Signal a running `stream_audio_metrics` call to stop after the current frame.
#[tauri::command]
async fn stop_dsp_stream(stream_generation: tauri::State<'_, Arc<AtomicU64>>) -> Result<(), String> {
    // Increment the generation counter — the current blocking task will see its captured
    // generation no longer matches and will exit on the next loop iteration.
    stream_generation.fetch_add(1, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
async fn set_stem_state(
    stem_states: tauri::State<'_, Arc<RwLock<HashMap<String, StemState>>>>,
    stem_id: String,
    is_solo: bool,
    is_muted: bool,
) -> Result<(), String> {
    let normalized = stem_id.trim().to_ascii_lowercase();
    if !matches!(
        normalized.as_str(),
        "dx" | "music" | "sfx" | "foley" | "ambience"
    ) {
        return Err(format!(
            "Invalid stem_id '{stem_id}'. Allowed values: dx, music, sfx, foley, ambience"
        ));
    }

    let mut map = stem_states
        .write()
        .map_err(|_| "stem state lock poisoned".to_string())?;
    map.insert(normalized, StemState { is_solo, is_muted });

    Ok(())
}

/// Stream DSP metrics from the 5-stem WAV set (DX, music, foley, sfx, ambience) to the frontend.
///
/// Emits:
/// - `dsp-frame`    — `DspFramePayload` at up to 60 FPS during processing.
/// - `dsp-complete` — `DspCompletePayload` once when the file finishes naturally.
/// - `dsp-error`    — `String` if a decode or analysis error occurs.
///
/// Calling this command while a previous stream is in progress automatically cancels
/// the previous stream (the shared `cancel_flag` is reset to `false` then re-used).
#[tauri::command]
async fn stream_audio_metrics(
    app: tauri::AppHandle,
    stream_generation: tauri::State<'_, Arc<AtomicU64>>,
    stem_states: tauri::State<'_, Arc<RwLock<HashMap<String, StemState>>>>,
    dx_path: String,
    music_path: String,
    foley_path: String,
    sfx_path: String,
    ambience_path: String,
    start_time: f64,
) -> Result<(), String> {
    ensure_safe_argument("DX path", &dx_path)?;
    ensure_safe_argument("Music path", &music_path)?;
    ensure_safe_argument("Foley path", &foley_path)?;
    ensure_safe_argument("SFX path", &sfx_path)?;
    ensure_safe_argument("Ambience path", &ambience_path)?;
    if !start_time.is_finite() || start_time < 0.0 {
        return Err("start_time must be a finite value >= 0".to_string());
    }

    // Each stream gets a unique generation number. The old blocking task holds a clone
    // of the counter and its own captured generation value. When we increment here the
    // old task sees a mismatch on the next loop iteration and exits cleanly — no
    // shared-flag reset race, no need to await the old task's handle.
    let my_gen = stream_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let stream_gen_arc = Arc::clone(&*stream_generation);
    let shared_stem_states = Arc::clone(&*stem_states);

    tokio::task::spawn_blocking(move || {
        let mut decoder = MikupAudioDecoder::new(
            &dx_path,
            &music_path,
            &foley_path,
            &sfx_path,
            &ambience_path,
            shared_stem_states,
            DSP_SAMPLE_RATE,
            DSP_FRAME_SIZE,
        )
        .map_err(|e| e.to_string())?;
        decoder
            .seek(start_time as f32)
            .map_err(|e| format!("Failed to seek decoder: {e}"))?;

        let sample_rate = decoder.target_sample_rate();
        let frame_size = decoder.frame_size();

        let mut loudness = LoudnessAnalyzer::new(sample_rate).map_err(|e| e.to_string())?;
        let spatial = SpatialAnalyzer::new();
        let mut spectral = SpectralAnalyzer::new(sample_rate, frame_size);

        // Audio output: create a cpal player and a resampler (48kHz → hardware rate).
        // Failure to open the output device is non-fatal — analysis continues without audio.
        let audio_player = AudioOutputPlayer::new_default(0.2)
            .map_err(|e| eprintln!("[mikup] Audio output unavailable: {e}"))
            .ok();
        let mut audio_resampler = audio_player.as_ref().and_then(|p| {
            MonoResampler::new(sample_rate, p.hardware_sample_rate())
                .map_err(|e| eprintln!("[mikup] Audio resampler init failed: {e}"))
                .ok()
        });
        if let Some(ref p) = audio_player {
            if let Err(e) = p.start() {
                eprintln!("[mikup] Audio player start failed: {e}");
            }
        }

        let mut frame_index: u64 = 0;
        let min_interval = std::time::Duration::from_millis(MIN_EMIT_INTERVAL_MS);
        let mut last_emit: Option<std::time::Instant> = None;
        let mut eof_natural = false;

        loop {
            if stream_gen_arc.load(Ordering::Relaxed) != my_gen {
                break;
            }

            let frame = match decoder.read_frame() {
                Ok(Some(f)) => f,
                Ok(None) => {
                    eof_natural = true;
                    break;
                }
                Err(e) => {
                    let _ = app.emit("dsp-error", e.to_string());
                    return Err(e.to_string());
                }
            };

            let timestamp_secs = frame_index as f32 * frame_size as f32 / sample_rate as f32;

            let loudness_metrics = match loudness.process_frame(&frame) {
                Ok(m) => m,
                Err(e) => {
                    let _ = app.emit("dsp-error", e.to_string());
                    return Err(e.to_string());
                }
            };

            let spatial_metrics = spatial.process_frame(&frame);
            let spectral_metrics = spectral.process_frame(&frame);

            // Push mixed audio (dialogue + background) to cpal output player.
            if let (Some(ref player), Some(ref mut resampler)) =
                (&audio_player, &mut audio_resampler)
            {
                let mixed: Vec<f32> = frame
                    .dialogue_raw
                    .iter()
                    .zip(frame.background_raw.iter())
                    .map(|(d, b)| (d + b).clamp(-1.0, 1.0))
                    .collect();
                let resampled = resampler.process(&mixed);
                let interleaved = interleave_mono(&resampled, player.channels());
                player.push_interleaved_nonblocking(&interleaved);
            }

            frame_index += 1;

            // Throttle: skip emit if the minimum interval hasn't elapsed yet.
            let now = std::time::Instant::now();
            let should_emit = match last_emit {
                None => true,
                Some(t) => now.duration_since(t) >= min_interval,
            };
            if !should_emit {
                continue;
            }
            last_emit = Some(now);

            // Subsample Lissajous points so each frame emits at most LISSAJOUS_MAX_POINTS.
            let step = (spatial_metrics.lissajous_points.len() / LISSAJOUS_MAX_POINTS).max(1);
            let lissajous_points: Vec<[f32; 2]> = spatial_metrics
                .lissajous_points
                .iter()
                .step_by(step)
                .map(|p| [p.x, p.y])
                .collect();

            let payload = DspFramePayload {
                frame_index,
                timestamp_secs,
                dialogue_momentary_lufs: loudness_metrics.dialogue.momentary_lufs,
                dialogue_short_term_lufs: loudness_metrics.dialogue.short_term_lufs,
                dialogue_true_peak_dbtp: loudness_metrics.dialogue.true_peak_dbtp,
                dialogue_crest_factor: loudness_metrics.dialogue.crest_factor,
                background_momentary_lufs: loudness_metrics.background.momentary_lufs,
                background_short_term_lufs: loudness_metrics.background.short_term_lufs,
                background_true_peak_dbtp: loudness_metrics.background.true_peak_dbtp,
                background_crest_factor: loudness_metrics.background.crest_factor,
                phase_correlation: spatial_metrics.phase_correlation,
                lissajous_points,
                dialogue_centroid_hz: spectral_metrics.dialogue_centroid_hz,
                background_centroid_hz: spectral_metrics.background_centroid_hz,
                speech_pocket_masked: spectral_metrics.speech_pocket_masked,
                dialogue_speech_energy: spectral_metrics.dialogue_speech_energy,
                background_speech_energy: spectral_metrics.background_speech_energy,
                snr_db: spectral_metrics.snr_db,
            };

            let _ = app.emit("dsp-frame", payload);
        }

        if let Some(ref player) = audio_player {
            player.mark_producer_finished();
        }

        // Warn if any stems were shorter than others and were padded with silence.
        if decoder.alignment_mismatch_detected {
            let _ = app.emit(
                "process-status",
                ProgressPayload {
                    stage: "DSP_WARNING".to_string(),
                    progress: 0,
                    message: "Stem length mismatch: one or more stems are shorter than others and were padded with silence. Spatial and ducking analysis may be affected near the tail.".to_string(),
                },
            );
        }

        // Only emit the completion event when we reached EOF naturally (not cancelled).
        if eof_natural {
            let final_metrics = loudness.final_metrics();
            let _ = app.emit(
                "dsp-complete",
                DspCompletePayload {
                    total_frames: frame_index,
                    dialogue_integrated_lufs: final_metrics.dialogue.integrated_lufs,
                    dialogue_loudness_range_lu: final_metrics.dialogue.loudness_range_lu,
                    background_integrated_lufs: final_metrics.background.integrated_lufs,
                    background_loudness_range_lu: final_metrics.background.loudness_range_lu,
                },
            );
        }

        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Emitted once per tool call the AI Director makes during a turn.
#[derive(Clone, serde::Serialize)]
struct AgentActionPayload {
    tool: String,
    time_secs: Option<f64>,
}

/// Send a single message to the AI Director Python sidecar and return its reply.
///
/// The Python process (`src/llm/interactive.py`) communicates over stdin/stdout
/// using newline-delimited JSON:
///   Rust  → Python stdin:  `{"text": "<user message>"}\n`
///   Python → Rust stdout:  `{"type": "ready"}\n`           (once, on startup)
///                          `{"tool": "<name>", ...}\n`      (zero or more tool calls)
///                          `{"type": "response", "text": "..."}\n`
///
/// Each tool call is forwarded to the frontend as an `agent-action` Tauri event.
///
/// # Security
/// `workspace_dir` must be an absolute path. The value is passed verbatim as the
/// `WORKSPACE_DIR` environment variable so Python's `_is_path_safe` can correctly
/// sandbox file access to the project workspace.
#[tauri::command]
async fn send_agent_message(
    app: tauri::AppHandle,
    text: String,
    workspace_dir: String,
) -> Result<String, String> {
    ensure_safe_argument("Text", &text)?;
    ensure_safe_argument("Workspace directory", &workspace_dir)?;

    let workspace_path = PathBuf::from(&workspace_dir);
    if !workspace_path.is_absolute() {
        return Err("Path Denied: workspace_dir must be an absolute path".to_string());
    }
    if !workspace_path.is_dir() {
        return Err(format!("Workspace directory not found: {workspace_dir}"));
    }

    let project_root =
        find_project_root(&app).ok_or_else(|| "Unable to resolve project root".to_string())?;
    let python_path = resolve_python_path(&project_root);

    let (mut rx, mut child) = app
        .shell()
        .command(&python_path)
        .current_dir(&project_root)
        .args(["-m", "src.llm.interactive"])
        .env("WORKSPACE_DIR", &workspace_dir)
        .spawn()
        .map_err(|e| format!("Failed to spawn AI Director: {e}"))?;

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(120);
    let mut buf = String::new();
    let mut ready = false;
    let mut result: Result<String, String> =
        Err("AI Director did not return a response".to_string());

    'outer: loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            result = Err("AI Director timed out".to_string());
            break;
        }

        let maybe_event = match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(ev) => ev,
            Err(_) => {
                result = Err("AI Director timed out".to_string());
                break;
            }
        };

        match maybe_event {
            Some(CommandEvent::Stdout(chunk)) => {
                buf.push_str(&String::from_utf8_lossy(&chunk));
                while let Some(pos) = buf.find('\n') {
                    let line: String = buf.drain(..=pos).collect();
                    let trimmed = line.trim_end_matches('\n').trim_end_matches('\r');
                    if trimmed.is_empty() {
                        continue;
                    }
                    if let Ok(json_val) = serde_json::from_str::<serde_json::Value>(trimmed) {
                        let msg_type = json_val.get("type").and_then(|t| t.as_str()).unwrap_or("");
                        if msg_type == "ready" && !ready {
                            ready = true;
                            let msg = serde_json::json!({"text": text}).to_string() + "\n";
                            if let Err(e) = child.write(msg.as_bytes()) {
                                result = Err(format!("Failed to send message to AI Director: {e}"));
                                break 'outer;
                            }
                        } else if msg_type == "response" && ready {
                            let response_text = json_val
                                .get("text")
                                .and_then(|t| t.as_str())
                                .unwrap_or("")
                                .to_string();
                            result = Ok(response_text);
                            break 'outer;
                        } else if let Some(tool_name) =
                            json_val.get("tool").and_then(|t| t.as_str())
                        {
                            let time_secs = json_val.get("time_secs").and_then(|t| t.as_f64());
                            let _ = app.emit(
                                "agent-action",
                                AgentActionPayload {
                                    tool: tool_name.to_string(),
                                    time_secs,
                                },
                            );
                        }
                    }
                }
            }
            Some(CommandEvent::Stderr(_)) => {
                // Python logging to stderr — ignored by design.
            }
            Some(CommandEvent::Terminated(status)) => {
                if result.is_err() && status.code != Some(0) {
                    result = Err(format!(
                        "AI Director exited unexpectedly (code {:?})",
                        status.code
                    ));
                }
                break;
            }
            Some(_) | None => break,
        }
    }

    let _ = child.kill();
    result
}

#[cfg(test)]
mod lib_tests {
    #[test]
    fn stage_state_json_merge_preserves_existing_stages() {
        // Simulate the read-parse-merge-serialize logic used by mark_dsp_complete
        let initial_json =
            r#"{"stages":{"separation":{"completed":true},"transcription":{"completed":true}}}"#;

        let mut state: serde_json::Value = serde_json::from_str(initial_json)
            .unwrap_or_else(|_| serde_json::json!({ "stages": {} }));

        state["stages"]["dsp"] = serde_json::json!({ "completed": true });

        let serialized = serde_json::to_string(&state).unwrap();

        // Round-trip: parse the serialized output to verify the full write/read cycle
        let roundtripped: serde_json::Value = serde_json::from_str(&serialized).unwrap();

        assert_eq!(
            roundtripped["stages"]["separation"]["completed"].as_bool(),
            Some(true)
        );
        assert_eq!(
            roundtripped["stages"]["transcription"]["completed"].as_bool(),
            Some(true)
        );
        assert_eq!(
            roundtripped["stages"]["dsp"]["completed"].as_bool(),
            Some(true)
        );

        // Verify serialization produces valid JSON (not just in-memory state)
        assert!(
            serialized.contains(r#""dsp":{"completed":true}"#)
                || serialized.contains(r#""dsp": {"completed": true}"#)
        );
    }

    #[test]
    fn stage_state_json_merge_starts_fresh_on_missing_file() {
        // Simulate fallback when file doesn't exist (parse fails → empty state)
        let corrupt_or_empty = "";

        let mut state: serde_json::Value = serde_json::from_str(corrupt_or_empty)
            .unwrap_or_else(|_| serde_json::json!({ "stages": {} }));

        state["stages"]["dsp"] = serde_json::json!({ "completed": true });

        assert_eq!(state["stages"]["dsp"]["completed"].as_bool(), Some(true));
        // Other stages should not exist (we started from empty)
        assert!(state["stages"]["separation"].is_null());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(AtomicU64::new(0)))
        .manage(shared_default_stem_states())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            process_audio,
            run_pipeline_stage,
            read_output_payload,
            get_stems,
            get_history,
            get_app_config,
            set_default_projects_dir,
            setup_project_workspace,
            get_pipeline_state,
            write_dsp_metrics,
            generate_static_map,
            stream_audio_metrics,
            stop_dsp_stream,
            set_stem_state,
            mark_dsp_complete,
            send_agent_message,
        ])
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
