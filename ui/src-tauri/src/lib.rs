use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use crate::dsp::loudness::LoudnessAnalyzer;
use crate::dsp::spatial::SpatialAnalyzer;
use crate::dsp::spectral::SpectralAnalyzer;
use crate::dsp::MikupAudioDecoder;

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
async fn get_pipeline_state(output_directory: String) -> Result<u32, String> {
    ensure_safe_argument("Output directory", &output_directory)?;

    let state_path = PathBuf::from(&output_directory).join("stage_state.json");

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

/// Marks the DSP stage as complete in `stage_state.json`.
/// Called by the frontend after the Rust `stream_audio_metrics` stream ends naturally.
/// This allows `get_pipeline_state` to correctly report 3 completed stages on resume.
#[tauri::command]
async fn mark_dsp_complete(output_directory: String) -> Result<(), String> {
    ensure_safe_argument("Output directory", &output_directory)?;

    let state_path = PathBuf::from(&output_directory).join("stage_state.json");

    let mut state: serde_json::Value = if state_path.exists() {
        let content = tokio::fs::read_to_string(&state_path)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::from_str(&content)
            .unwrap_or_else(|_| serde_json::json!({ "stages": {} }))
    } else {
        serde_json::json!({ "stages": {} })
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
async fn stop_dsp_stream(
    cancel_flag: tauri::State<'_, Arc<AtomicBool>>,
) -> Result<(), String> {
    cancel_flag.store(true, Ordering::Relaxed);
    Ok(())
}

/// Stream DSP metrics from the dialogue and background WAV stems to the frontend.
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
    cancel_flag: tauri::State<'_, Arc<AtomicBool>>,
    dialogue_path: String,
    background_path: String,
) -> Result<(), String> {
    ensure_safe_argument("Dialogue path", &dialogue_path)?;
    ensure_safe_argument("Background path", &background_path)?;

    // Reset cancellation so any lingering previous stream sees `true` → stops, and
    // our new stream starts clean with `false`.
    cancel_flag.store(false, Ordering::Relaxed);
    let cancel = Arc::clone(&*cancel_flag);

    tokio::task::spawn_blocking(move || {
        let mut decoder =
            MikupAudioDecoder::new(&dialogue_path, &background_path, DSP_SAMPLE_RATE, DSP_FRAME_SIZE)
                .map_err(|e| e.to_string())?;

        let sample_rate = decoder.target_sample_rate();
        let frame_size = decoder.frame_size();

        let mut loudness = LoudnessAnalyzer::new(sample_rate).map_err(|e| e.to_string())?;
        let spatial = SpatialAnalyzer::new();
        let mut spectral = SpectralAnalyzer::new(sample_rate, frame_size);

        let mut frame_index: u64 = 0;
        let min_interval = std::time::Duration::from_millis(MIN_EMIT_INTERVAL_MS);
        let mut last_emit: Option<std::time::Instant> = None;
        let mut eof_natural = false;

        loop {
            if cancel.load(Ordering::Relaxed) {
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

            let timestamp_secs =
                frame_index as f32 * frame_size as f32 / sample_rate as f32;

            let loudness_metrics = match loudness.process_frame(&frame) {
                Ok(m) => m,
                Err(e) => {
                    let _ = app.emit("dsp-error", e.to_string());
                    return Err(e.to_string());
                }
            };

            let spatial_metrics = spatial.process_frame(&frame);
            let spectral_metrics = spectral.process_frame(&frame);

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
            let step =
                (spatial_metrics.lissajous_points.len() / LISSAJOUS_MAX_POINTS).max(1);
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

#[cfg(test)]
mod lib_tests {
    #[test]
    fn stage_state_json_merge() {
        let existing = serde_json::json!({
            "stages": {
                "separation": { "completed": true },
                "transcription": { "completed": true }
            }
        });
        let mut state = existing.clone();
        state["stages"]["dsp"] = serde_json::json!({ "completed": true });

        assert_eq!(
            state["stages"]["separation"]["completed"].as_bool(),
            Some(true)
        );
        assert_eq!(
            state["stages"]["dsp"]["completed"].as_bool(),
            Some(true)
        );
        assert_eq!(
            state["stages"]["transcription"]["completed"].as_bool(),
            Some(true)
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(AtomicBool::new(false)))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            process_audio,
            run_pipeline_stage,
            read_output_payload,
            get_history,
            get_pipeline_state,
            stream_audio_metrics,
            stop_dsp_stream,
            mark_dsp_complete,
        ])
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
