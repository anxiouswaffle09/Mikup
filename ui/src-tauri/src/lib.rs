use tokio::process::Command;
use std::path::PathBuf;
use tauri::Manager;

#[tauri::command]
async fn process_audio(app: tauri::AppHandle, input_path: String) -> Result<String, String> {
    // 1. Identify paths
    // In dev mode, we use the local venv. In prod, we use the sidecar binary.
    let resource_path = app.path().resource_dir().map_err(|e| e.to_string())?;
    
    // For Dev: Check relative to executable
    let mut python_path = PathBuf::from("../../../.venv/bin/python3");
    let mut script_path = PathBuf::from("../../../src/main.py");
    let mut output_path = PathBuf::from("../../../data/output/mikup_payload.json");

    if !python_path.exists() {
        // Fallback or Prod logic: This would ideally be a sidecar binary call
        return Err("Python environment not found. Ensure .venv is initialized.".to_string());
    }

    // 2. Run Process Async (Tokio)
    let output = Command::new(python_path)
        .env("PYTHONPATH", "../../..") // Adjust for nested tauri structure
        .arg(script_path)
        .arg("--input")
        .arg(input_path)
        .arg("--output")
        .arg(&output_path)
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Pipeline failed: {}", error));
    }

    // 3. Read result
    let payload = tokio::fs::read_to_string(output_path)
        .await
        .map_err(|e| format!("Failed to read payload: {}", e))?;

    Ok(payload)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![process_audio])
    .setup(|app| {
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
