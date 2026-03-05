# Library Reference: Tauri v2 (Stable)

Updated as of: March 2, 2026

## 1. Syntax & Plugin Reference
*(... See previous version for Dialog/FS patterns ...)*

---

## 2. 🚫 Anti-AI Slop (Tauri v2)
Tauri v2 is a complete architectural shift from v1. AI models often default to v1 "slop."

**Hybrid Environment Note:** Codebase is in Windows (`/mnt/d/SoftwareDev/Mikup/`); Agents/Runtime in WSL2 (Linux). Use `tauri:wsl` for rendering and `WEBKIT_DISABLE_COMPOSITING_MODE=1`.

| Legacy/Slop Pattern | Modern Standard (2026) | Why? |
| :--- | :--- | :--- |
| `invoke("command")` | **`tauri-specta` v2** | Type-safe, contract-first bridge; zero string-matching errors. |
| Global `allowlist` | **Granular Capabilities** | ACL-based security; specific permissions per window. |
| Massive JSON Dispatcher | **Discrete Rust Commands** | Standardized Rust functions; easier to debug and audit. |
| Browser-based `<audio>` | **Native Rust Audio** | Jitter-free, sample-accurate playback via `cpal/rodio`. |
| `emit` for high-freq data | **`tauri::ipc::Channel`** | Bypasses JSON overhead for 60fps meter telemetry. |
| Hardcoded path strings | **`app.path()` trait** | Cross-platform safety (WSL2/macOS/Windows). |

---

## 3. High-Performance IPC (Channels)
```rust
// Rust: Create a telemetry channel
let (tx, rx) = tauri::ipc::Channel::new();
// Frontend: Stream raw bytes
rx.on_message(|bytes| {
    update_vectorscope(bytes);
});
```

---

## 4. Best Practices for Mikup
1. **Type-Safe Bridge**: Use Specta to generate TypeScript bindings for all Commands.
2. **Contract-First**: Define the Rust struct for a Mikup event before implementing the UI.
3. **Async Subprocesses**: Use `spawn_blocking` for long-running Python ML stages to prevent UI freezing.
4. **Custom Protocol**: Use `tauri://` for serving local project waveforms.
