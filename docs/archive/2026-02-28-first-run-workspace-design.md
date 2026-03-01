# First-Run Setup & Automated Workspace Generation — Design

**Date:** 2026-02-28
**Scope:** React/TypeScript frontend only (Rust commands are already implemented)

---

## Context

The Rust side is complete: `get_app_config`, `set_default_projects_dir`, and `setup_project_workspace` are all registered Tauri commands in `ui/src-tauri/src/lib.rs`. The frontend has no wiring yet.

The goal is a frictionless "open file → analysis starts" flow. The user picks a default projects directory once, and every subsequent audio file automatically gets a timestamped workspace created inside it. The original file is copied into the workspace so it can never be broken by the user moving files.

---

## Architecture Decision: App.tsx owns config state

`App.tsx` must gate the entire UI behind a first-run modal before `LandingHub` mounts. Because of this gate, config must live in `App.tsx`. Prop-drilling to `LandingHub` is the correct pattern — no context needed.

---

## Types (`ui/src/types.ts`)

Add two interfaces (no changes to existing types):

```ts
export interface AppConfig {
  default_projects_dir: string;
}

export interface WorkspaceSetupResult {
  workspace_dir: string;
  copied_input_path: string;
}
```

---

## App.tsx changes

### New state
- `config: AppConfig | null` — null while loading on mount
- `showFirstRunModal: boolean` — true when config loads with `default_projects_dir === ''`

### Mount effect
```
invoke<AppConfig>('get_app_config')
  → if default_projects_dir === '' → setShowFirstRunModal(true)
  → else → setConfig(result)
```
While config is null and `showFirstRunModal` is false, render nothing (avoids flash of landing page).

### First-run modal
Inline JSX in App.tsx (no new component file). Fixed full-screen overlay with backdrop. Centered card:
- Label: `INITIAL SETUP` (10px caps tracking)
- Title: `Welcome to Mikup` (semibold)
- One-line description: "Choose a folder where Mikup will create project workspaces."
- `Choose Folder…` button → `open({ directory: true })` → `invoke('set_default_projects_dir', { path })` → sets config, dismisses modal
- Not dismissable without completing setup (no escape, no backdrop click, no X)
- Aesthetic: same panel-border, accent, monospace tokens as the rest of the app

### handleStartNewProcess refactor
Signature: `(filePath: string, overrideDir?: string) => Promise<void>`

```
const dir = overrideDir ?? config.default_projects_dir
const result = await invoke<WorkspaceSetupResult>('setup_project_workspace', {
  inputPath: filePath,
  baseDirectory: dir,
})
setInputPath(result.copied_input_path)   // ← pipeline runs against workspace copy
setWorkspaceDirectory(result.workspace_dir)
// existing: get_pipeline_state → resume logic → setView('processing')
```

The directory-picker call that previously opened inside `handleStartNewProcess` is removed entirely.

### onChangeDefaultFolder helper
New async function in App.tsx:
```
open({ directory: true })
  → invoke('set_default_projects_dir', { path })
  → setConfig(result)
```
Passed to LandingHub as a prop.

---

## LandingHub changes

### Updated props interface
```ts
interface LandingHubProps {
  onSelectProject: (payload: MikupPayload) => void;
  onStartNewProcess: (filePath: string, overrideDir?: string) => void;
  isProcessing: boolean;
  config: AppConfig | null;
  onChangeDefaultFolder: () => void;
}
```

### Default folder row
Between `<header>` and the drop-zone section:
```
DEFAULT WORKSPACE  ~/Projects/Mikup_Sessions  [Change]
```
- 10px monospace caps label, truncated path, small `[Change]` button that calls `onChangeDefaultFolder`
- Hidden if `config` is null

### Advanced: Manual Folder section
Below the drop-zone div, above the `dropError` block:
- Toggle: `▸ Advanced: Manual Folder` (10px font, clickable)
- When expanded: `[Choose Folder…]` button + resolved path display (font-mono text-text-muted)
- Local state: `manualOverrideDir: string | null`
- `handleSelectFile` and `handleDrop` pass `manualOverrideDir ?? undefined` as the second arg to `onStartNewProcess`
- Closing the toggle clears `manualOverrideDir`

---

## Error handling
- If `get_app_config` fails on mount: log error, show first-run modal (safe fallback)
- If `setup_project_workspace` fails: surface error via existing `setError` path in App.tsx
- If `set_default_projects_dir` fails in the first-run modal: show inline error in the modal, keep it open

---

## Files changed
1. `ui/src/types.ts` — add 2 interfaces
2. `ui/src/App.tsx` — config state, mount effect, first-run modal, handleStartNewProcess refactor, onChangeDefaultFolder
3. `ui/src/components/LandingHub.tsx` — updated props, default folder row, advanced toggle
