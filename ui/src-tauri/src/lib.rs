use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::Manager;
use tauri_plugin_shell::ShellExt;

fn contains_unsafe_shell_tokens(value: &str) -> bool {
    value.contains(';')
        || value.contains('|')
        || value.contains('&')
        || value.contains('`')
        || value.contains('\n')
        || value.contains('\r')
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
    let venv_python = project_root.join(".venv").join("bin").join("python3");
    if venv_python.is_file() {
        ".venv/bin/python3".to_string()
    } else {
        "python3".to_string()
    }
}

#[tauri::command]
async fn process_audio(app: tauri::AppHandle, input_path: String) -> Result<String, String> {
    if input_path.trim().is_empty() {
        return Err("Input path must not be empty".to_string());
    }
    if contains_unsafe_shell_tokens(&input_path) {
        return Err("Input path contains disallowed shell operator characters".to_string());
    }

    let project_root =
        find_project_root(&app).ok_or_else(|| "Unable to resolve project root".to_string())?;
    let output_path = project_root.join("data/output/mikup_payload.json");
    let output_path_arg = output_path.to_string_lossy().into_owned();
    if contains_unsafe_shell_tokens(&output_path_arg) {
        return Err(
            "Resolved output path contains disallowed shell operator characters".to_string(),
        );
    }

    let input_path_arg = PathBuf::from(input_path).to_string_lossy().into_owned();
    let python_path = resolve_python_path(&project_root);
    let output = app
        .shell()
        .command(&python_path)
        .current_dir(&project_root)
        .args([
            "-m",
            "src.main",
            "--input",
            input_path_arg.as_str(),
            "--output",
            output_path_arg.as_str(),
        ])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Pipeline failed: {}", error));
    }

    // Read result using tokio
    let payload = tokio::fs::read_to_string(output_path)
        .await
        .map_err(|e| format!("Failed to read payload: {}", e))?;

    Ok(payload)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![process_audio])
        .setup(|app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
