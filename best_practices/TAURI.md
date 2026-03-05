# Best Practices: Tauri v2 (Stable)

Updated as of: March 2, 2026

## Core Version: v2.10.x
Tauri v2 is the production standard. All core features are now **Plugins**.

### Key Practices:
- **Plugin-First:** Use `@tauri-apps/plugin-*` for Filesystem, Dialog, and Shell. Do not expect them to be in the core `tauri` package.
- **Capability-Based Security (ACLs):** All window permissions must be explicitly defined in `src-tauri/capabilities/default.json`. 
  - *Standard:* Never use `core:default`. Grant specific permissions (e.g., `fs:allow-read-recursive`) restricted to the `Projects/` directory.
- **Custom Protocol:** Always use `tauri://` for serving the UI. Avoid `localhost` in production for security.

## High-Performance IPC (DAW Meters)
- **Raw Byte Channels:** For high-frequency diagnostic data (Vectorscope, LUFS), use the new `tauri::ipc::Channel` to stream raw `f32` buffers. 
- **Avoid JSON:** Do NOT serialize audio visualization data to JSON. The overhead will cause UI jitter.
- **State Management:** Use `tauri::State` in Rust to manage the persistent Audio Engine handle across window reloads.

## Cross-Platform Parity
- **Path Resolution:** Always use the `@tauri-apps/api/path` plugin. Never hardcode path separators.
- **Hybrid Environment (WSL2/Windows):** 
  - The codebase resides in `/mnt/d/SoftwareDev/Mikup/`. 
  - Build and runtime tools (Cargo, npm) must be Linux versions running in WSL2.
  - **WSL2 Rendering:** Use `WEBKIT_DISABLE_COMPOSITING_MODE=1` to bypass hardware acceleration bugs.
  - **Inter-OS Communication:** Be aware that file watching (`HMR`) can be slower across the WSL/Windows file system boundary; prefer specific file triggers if needed.
