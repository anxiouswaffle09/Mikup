use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

#[derive(Clone, serde::Serialize)]
struct ProgressPayload {
    stage: String,
    progress: u32,
    message: String,
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
    let windows_python = project_root.join(".venv").join("Scripts").join("python.exe");
    if windows_python.is_file() {
        return windows_python.to_string_lossy().into_owned();
    }
    "python3".to_string()
}

fn resolve_output_paths(output_directory: &str) -> Result<(PathBuf, String, PathBuf, String), String> {
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

    let mut args = build_base_pipeline_args(&input_path_arg, &output_directory_arg, &output_path_arg);
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

    let canonical_order = ["separation", "transcription", "dsp", "semantics", "director"];
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            process_audio,
            run_pipeline_stage,
            read_output_payload,
            get_history,
            get_pipeline_state
        ])
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
