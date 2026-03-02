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
- **WSL2 Rendering:** Use `WEBKIT_DISABLE_COMPOSITING_MODE=1` for Linux/Windows hybrid environments to bypass hardware acceleration bugs.
- **Mobile-Ready:** Keep Rust logic in modular plugins to allow for future iOS/Android porting.
