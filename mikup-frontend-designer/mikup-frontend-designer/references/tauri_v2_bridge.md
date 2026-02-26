# Tauri v2 Bridge

## Architecture

The Mikup frontend interacts with the Python backend via Tauri's Rust commands. Rust acts as a secure intermediary, spawning the Python subprocess and piping results back to the React UI.

### In `ui/src-tauri/src/lib.rs`:

```rust
#[tauri::command]
fn process_audio(audio_path: String) -> String {
    let output = std::process::Command::new(".venv/bin/python3")
        .args(["src/main.py", "--input", &audio_path])
        .output()
        .expect("Failed to execute Python process");
    
    String::from_utf8_lossy(&output.stdout).to_string()
}
```

### In React (`IngestionHeader.tsx`):

```tsx
import { invoke } from "@tauri-apps/api/core";

async function handleStartProcess(path: string) {
  try {
    const jsonString = await invoke("process_audio", { audioPath: path });
    const payload = JSON.parse(jsonString as string);
    // Update App level state
  } catch (error) {
    console.error("Pipeline failed:", error);
  }
}
```

## Security and Capabilities

Tauri v2 uses a granular permission system. Ensure `ui/src-tauri/capabilities/default.json` includes the necessary scopes for filesystem and audio access.

### Permissions:

- `fs:allow-read`: For reading raw audio files.
- `fs:allow-write`: For writing processed stems and payloads to `data/`.
- `shell:allow-execute`: For running the `.venv/bin/python3` sidecar.
- `audio:allow-play`: For playback in `WaveformVisualizer`.
