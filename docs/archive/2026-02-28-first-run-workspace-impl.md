# First-Run Setup & Automated Workspace Generation — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire up the Tauri `get_app_config` / `set_default_projects_dir` / `setup_project_workspace` commands into the React frontend so that first-time users are prompted to choose a default projects folder, and every subsequent audio file automatically creates a timestamped workspace (copying the source file in) before the pipeline runs.

**Architecture:** `App.tsx` owns `AppConfig` state, fetched on mount via `get_app_config`. A blocking first-run modal collects `default_projects_dir` if it is empty. `handleStartNewProcess` is refactored to call `setup_project_workspace` instead of manually prompting for a folder — the pipeline runs against the copied file inside the workspace. `LandingHub` gains a "Change Default Folder" affordance and an opt-in "Advanced: Manual Folder" section for one-off overrides.

**Tech Stack:** React 19, TypeScript 5.9, Tauri 2, `@tauri-apps/api/core` (`invoke`), `@tauri-apps/plugin-dialog` (`open`), Tailwind CSS v4, `lucide-react`

> **No unit test runner exists in this project.** Each task uses `cd ui && npx tsc --noEmit` as the compile gate and `npm run lint` as the style gate. Manual smoke-test steps note what to verify in `npm run tauri:wsl`.

---

### Task 1: Add AppConfig and WorkspaceSetupResult to types.ts

**Files:**
- Modify: `ui/src/types.ts` (append after line 141, before `type PayloadRecord`)

**Step 1: Add the two interfaces**

Open `ui/src/types.ts`. Find the line:
```ts
export interface HistoryEntry {
```
Insert the two new interfaces **after** the `HistoryEntry` block (after the closing `}` on its last line, before `type PayloadRecord = ...`):

```ts
export interface AppConfig {
  default_projects_dir: string;
}

export interface WorkspaceSetupResult {
  workspace_dir: string;
  copied_input_path: string;
}
```

**Step 2: Verify compile**

```bash
cd ui && npx tsc --noEmit
```
Expected: no errors.

**Step 3: Commit**

```bash
git add ui/src/types.ts
git commit -m "feat(types): add AppConfig and WorkspaceSetupResult interfaces"
```

---

### Task 2: Load config on App mount and add config / first-run-modal state

**Files:**
- Modify: `ui/src/App.tsx`

**Context:** `App.tsx` currently imports from `./types` — add `AppConfig` and `WorkspaceSetupResult` to that import. Add state and a mount effect.

**Step 1: Update the types import at the top of App.tsx**

Locate the existing import block:
```ts
import {
  parseMikupPayload,
  resolveStemAudioSources,
  type MikupPayload,
  type PipelineStageDefinition,
  type DspCompletePayload,
} from './types';
```
Replace with:
```ts
import {
  parseMikupPayload,
  resolveStemAudioSources,
  type MikupPayload,
  type PipelineStageDefinition,
  type DspCompletePayload,
  type AppConfig,
  type WorkspaceSetupResult,
} from './types';
```

**Step 2: Add config and modal state inside the `App()` function**

Find the existing state block near the top of `function App()`:
```ts
const [loudnessTargetId, setLoudnessTargetId] = useState<LoudnessTargetId>('streaming');
```
After that line, add:
```ts
const [config, setConfig] = useState<AppConfig | null>(null);
const [showFirstRunModal, setShowFirstRunModal] = useState(false);
```

**Step 3: Add the mount effect (config fetch)**

Find the last existing `useEffect` block in App (the one that watches `dspStream.error`, ending around line 206). Insert a new `useEffect` **before** the `handleStartNewProcess` function:

```ts
// Load app config on mount; gate on first-run modal if no default projects dir is set.
useEffect(() => {
  invoke<AppConfig>('get_app_config')
    .then((cfg) => {
      if (!cfg.default_projects_dir) {
        setShowFirstRunModal(true);
      } else {
        setConfig(cfg);
      }
    })
    .catch(() => {
      // Config unreadable — show first-run modal as safe fallback.
      setShowFirstRunModal(true);
    });
}, []); // eslint-disable-line react-hooks/exhaustive-deps
```

**Step 4: Verify compile**

```bash
cd ui && npx tsc --noEmit
```
Expected: no errors. (The new state is declared but not yet used in JSX — TypeScript will not error on unused state variables.)

**Step 5: Commit**

```bash
git add ui/src/App.tsx
git commit -m "feat(app): load AppConfig on mount, add config + first-run modal state"
```

---

### Task 3: Render the first-run modal

**Files:**
- Modify: `ui/src/App.tsx`

**Context:** The modal must block all other views until a folder is chosen. It shows when `showFirstRunModal` is true. After the user picks and saves a folder, it sets `config` and hides.

**Step 1: Add the `handleFirstRunSave` function**

Insert this function right before the `handleStartNewProcess` function in App.tsx:

```ts
const handleFirstRunSave = async () => {
  const selectedDir = await open({
    multiple: false,
    directory: true,
    title: 'Choose your default Mikup projects folder',
  });
  if (typeof selectedDir !== 'string') return;

  try {
    const saved = await invoke<AppConfig>('set_default_projects_dir', { path: selectedDir });
    setConfig(saved);
    setShowFirstRunModal(false);
  } catch (err: unknown) {
    setError(err instanceof Error ? err.message : String(err));
  }
};
```

**Step 2: Add the modal JSX**

Find the `if (view === 'landing')` block. Insert the modal gate **immediately before** it (so the landing view is never rendered while setup is pending):

```tsx
// Show nothing until config is resolved to avoid a flash of landing page.
if (!config && !showFirstRunModal) {
  return null;
}

if (showFirstRunModal) {
  return (
    <div className="fixed inset-0 bg-background flex items-center justify-center z-50">
      <div className="border border-panel-border p-8 max-w-md w-full mx-4 space-y-6 animate-in fade-in duration-300">
        <div>
          <p className="text-[10px] uppercase tracking-widest font-bold text-text-muted mb-2">
            Initial Setup
          </p>
          <h2 className="text-xl font-semibold text-text-main">Welcome to Mikup</h2>
        </div>
        <p className="text-sm text-text-muted font-mono leading-relaxed">
          Choose a folder where Mikup will create project workspaces. Each audio file you
          analyse will get its own timestamped subfolder inside this directory.
        </p>
        {error && (
          <p className="text-[11px] font-mono text-red-400">{error}</p>
        )}
        <button
          type="button"
          onClick={handleFirstRunSave}
          className="w-full border border-accent text-accent px-4 py-3 text-sm font-medium hover:bg-accent/5 transition-colors"
        >
          Choose Folder…
        </button>
      </div>
    </div>
  );
}
```

**Step 3: Verify compile and lint**

```bash
cd ui && npx tsc --noEmit && npm run lint
```
Expected: no errors.

**Step 4: Manual smoke-test note**

Run `npm run tauri:wsl`. On first launch (or after deleting `data/config.json`), the welcome modal should appear. Picking a folder should dismiss it and reveal the landing page. Backdrop clicks and Escape should do nothing.

**Step 5: Commit**

```bash
git add ui/src/App.tsx
git commit -m "feat(app): add first-run Welcome modal with folder picker"
```

---

### Task 4: Refactor handleStartNewProcess — remove manual folder picker, add workspace setup

**Files:**
- Modify: `ui/src/App.tsx`

**Context:** Currently `handleStartNewProcess` opens an `open({ directory: true })` dialog to pick an output folder. This is replaced by `invoke('setup_project_workspace')`. The function gains an optional `overrideDir` param for the advanced manual-folder path.

**Step 1: Replace the function signature and body**

Locate the entire `handleStartNewProcess` function (lines ~207–276 in current file). Replace it wholesale with:

```ts
const handleStartNewProcess = async (filePath: string, overrideDir?: string) => {
  if (!filePath.trim()) {
    setError('Selected audio file path is invalid.');
    return;
  }
  if (!config) {
    setError('App config not loaded. Restart the application.');
    return;
  }

  const baseDir = overrideDir ?? config.default_projects_dir;

  setIsPreparingWorkflow(true);
  setError(null);
  setPipelineErrors([]);

  try {
    const workspace = await invoke<WorkspaceSetupResult>('setup_project_workspace', {
      inputPath: filePath,
      baseDirectory: baseDir,
    });

    setInputPath(workspace.copied_input_path);
    setWorkspaceDirectory(workspace.workspace_dir);
    setRunningStageIndex(null);

    let resumeCount = 0;
    try {
      resumeCount = await invoke<number>('get_pipeline_state', {
        outputDirectory: workspace.workspace_dir,
      });
    } catch {
      resumeCount = 0;
    }

    setCompletedStageCount(resumeCount);

    if (resumeCount > 0 && resumeCount < PIPELINE_STAGES.length) {
      const nextStage = PIPELINE_STAGES[resumeCount];
      setWorkflowMessage(
        `Previous progress found. Resuming from Stage ${resumeCount + 1}: ${nextStage.label}.`
      );
      setProgress({ stage: 'INIT', progress: 0, message: `Resuming from stage ${resumeCount + 1}.` });
    } else if (resumeCount >= PIPELINE_STAGES.length) {
      try {
        const result = await invoke<string>('read_output_payload', {
          outputDirectory: workspace.workspace_dir,
        });
        const parsed = parseMikupPayload(JSON.parse(result));
        setPayload(parsed);
        setView('analysis');
        return;
      } catch {
        setWorkflowMessage('All stages previously completed. Re-run any stage or load results.');
        setProgress({ stage: 'COMPLETE', progress: 100, message: 'Previously completed.' });
      }
    } else {
      setWorkflowMessage('Workspace ready. Run Stage 1: Surgical Separation.');
      setProgress({ stage: 'INIT', progress: 0, message: 'Ready to run stage 1.' });
    }

    setView('processing');
  } catch (err: unknown) {
    setError(err instanceof Error ? err.message : String(err));
  } finally {
    setIsPreparingWorkflow(false);
  }
};
```

**Step 2: Verify compile**

```bash
cd ui && npx tsc --noEmit
```
Expected: no errors.

**Step 3: Commit**

```bash
git add ui/src/App.tsx
git commit -m "feat(app): refactor handleStartNewProcess to use setup_project_workspace"
```

---

### Task 5: Add onChangeDefaultFolder helper and pass new props to LandingHub

**Files:**
- Modify: `ui/src/App.tsx`

**Step 1: Add the `handleChangeDefaultFolder` function**

Insert after `handleFirstRunSave` (and before `handleStartNewProcess`):

```ts
const handleChangeDefaultFolder = async () => {
  const selectedDir = await open({
    multiple: false,
    directory: true,
    title: 'Change default Mikup projects folder',
  });
  if (typeof selectedDir !== 'string') return;

  try {
    const saved = await invoke<AppConfig>('set_default_projects_dir', { path: selectedDir });
    setConfig(saved);
  } catch (err: unknown) {
    setError(err instanceof Error ? err.message : String(err));
  }
};
```

**Step 2: Update the LandingHub JSX to pass the new props**

Find the `<LandingHub ... />` usage inside the `if (view === 'landing')` block:
```tsx
<LandingHub
  onSelectProject={handleSelectProject}
  onStartNewProcess={handleStartNewProcess}
  isProcessing={isPreparingWorkflow}
/>
```
Replace with:
```tsx
<LandingHub
  onSelectProject={handleSelectProject}
  onStartNewProcess={handleStartNewProcess}
  isProcessing={isPreparingWorkflow}
  config={config}
  onChangeDefaultFolder={handleChangeDefaultFolder}
/>
```

**Step 3: Verify compile**

```bash
cd ui && npx tsc --noEmit
```
Expected: TypeScript will error that `LandingHub` does not accept `config` or `onChangeDefaultFolder` props yet — this is expected and intentional. The error confirms the wiring is in place; Task 6 resolves it.

**Step 4: Commit**

```bash
git add ui/src/App.tsx
git commit -m "feat(app): add handleChangeDefaultFolder and wire new LandingHub props"
```

---

### Task 6: Update LandingHub props interface and add the default-folder row

**Files:**
- Modify: `ui/src/components/LandingHub.tsx`

**Step 1: Update the import to include AppConfig**

Current import:
```ts
import { parseHistoryEntry } from '../types';
import type { HistoryEntry, MikupPayload } from '../types';
```
Replace with:
```ts
import { parseHistoryEntry } from '../types';
import type { AppConfig, HistoryEntry, MikupPayload } from '../types';
```

**Step 2: Update LandingHubProps**

Replace the existing interface:
```ts
interface LandingHubProps {
  onSelectProject: (payload: MikupPayload) => void;
  onStartNewProcess: (filePath: string) => void;
  isProcessing: boolean;
}
```
With:
```ts
interface LandingHubProps {
  onSelectProject: (payload: MikupPayload) => void;
  onStartNewProcess: (filePath: string, overrideDir?: string) => void;
  isProcessing: boolean;
  config: AppConfig | null;
  onChangeDefaultFolder: () => void;
}
```

**Step 3: Destructure the new props in the component**

Replace:
```ts
export const LandingHub: React.FC<LandingHubProps> = ({
  onSelectProject,
  onStartNewProcess,
  isProcessing,
}) => {
```
With:
```ts
export const LandingHub: React.FC<LandingHubProps> = ({
  onSelectProject,
  onStartNewProcess,
  isProcessing,
  config,
  onChangeDefaultFolder,
}) => {
```

**Step 4: Add the default-folder row**

Find the `<header>` element inside the return JSX:
```tsx
<header className="mb-8 flex items-baseline justify-between">
  <h1 className="text-xl font-semibold tracking-tight text-text-main">Mikup</h1>
  <span className="text-[11px] font-mono text-text-muted">v0.1.0-alpha</span>
</header>
```
Replace with:
```tsx
<header className="mb-8 flex items-baseline justify-between">
  <h1 className="text-xl font-semibold tracking-tight text-text-main">Mikup</h1>
  <span className="text-[11px] font-mono text-text-muted">v0.1.0-alpha</span>
</header>

{config?.default_projects_dir && (
  <div className="flex items-center gap-3 mb-6 font-mono text-[11px] text-text-muted">
    <span className="uppercase tracking-widest font-bold">Default workspace</span>
    <span className="flex-1 truncate" title={config.default_projects_dir}>
      {config.default_projects_dir}
    </span>
    <button
      type="button"
      onClick={onChangeDefaultFolder}
      className="shrink-0 text-[10px] text-accent hover:underline"
    >
      Change
    </button>
  </div>
)}
```

**Step 5: Verify compile**

```bash
cd ui && npx tsc --noEmit
```
Expected: no errors.

**Step 6: Commit**

```bash
git add ui/src/components/LandingHub.tsx
git commit -m "feat(landing): add config prop, default-folder row, and Change button"
```

---

### Task 7: Add Advanced: Manual Folder toggle to LandingHub

**Files:**
- Modify: `ui/src/components/LandingHub.tsx`

**Step 1: Add manualOverrideDir state and advanced toggle state**

Inside the `LandingHub` component, after the existing `const [dropError, setDropError] = useState<string | null>(null);` line, add:

```ts
const [showAdvanced, setShowAdvanced] = useState(false);
const [manualOverrideDir, setManualOverrideDir] = useState<string | null>(null);
```

**Step 2: Add handlePickManualFolder function**

After the `loadHistory` function, add:

```ts
const handlePickManualFolder = async () => {
  const selected = await open({
    multiple: false,
    directory: true,
    title: 'Choose output folder for this run',
  });
  if (typeof selected === 'string') {
    setManualOverrideDir(selected);
  }
};
```

**Step 3: Update handleSelectFile to pass overrideDir**

Current:
```ts
const handleSelectFile = async () => {
  const selectedPath = await open({
    ...
  });

  if (typeof selectedPath === 'string') {
    onStartNewProcess(selectedPath);
  }
};
```
Replace the `onStartNewProcess(selectedPath)` call with:
```ts
  if (typeof selectedPath === 'string') {
    onStartNewProcess(selectedPath, manualOverrideDir ?? undefined);
  }
```

**Step 4: Update handleDrop to pass overrideDir**

Find:
```ts
onStartNewProcess(audioFilePath);
```
Replace with:
```ts
onStartNewProcess(audioFilePath, manualOverrideDir ?? undefined);
```

**Step 5: Add the Advanced section JSX**

Find the `dropError` block:
```tsx
{dropError && (
  <p className="mt-2 text-[11px] text-red-400 font-mono">{dropError}</p>
)}
```
Insert the advanced section **after** it:

```tsx
<div className="mt-3">
  <button
    type="button"
    onClick={() => {
      setShowAdvanced((v) => !v);
      if (showAdvanced) setManualOverrideDir(null);
    }}
    className="flex items-center gap-1.5 text-[10px] font-mono text-text-muted hover:text-accent transition-colors select-none"
  >
    <span className="transition-transform duration-150" style={{ display: 'inline-block', transform: showAdvanced ? 'rotate(90deg)' : 'none' }}>
      ▸
    </span>
    Advanced: Manual Folder
  </button>

  {showAdvanced && (
    <div className="mt-2 flex items-center gap-3 pl-4">
      <button
        type="button"
        onClick={handlePickManualFolder}
        className="text-[11px] font-mono border border-panel-border px-2 py-1 text-text-muted hover:border-accent hover:text-accent transition-colors"
      >
        Choose Folder…
      </button>
      {manualOverrideDir ? (
        <span className="text-[11px] font-mono text-text-muted truncate flex-1" title={manualOverrideDir}>
          {manualOverrideDir}
        </span>
      ) : (
        <span className="text-[11px] font-mono text-text-muted italic">No folder selected — default will be used</span>
      )}
    </div>
  )}
</div>
```

**Step 6: Verify compile and lint**

```bash
cd ui && npx tsc --noEmit && npm run lint
```
Expected: no errors.

**Step 7: Manual smoke-test notes**

Run `npm run tauri:wsl`:
- The advanced section should be collapsed by default.
- Clicking the toggle expands it; clicking again collapses it and resets `manualOverrideDir`.
- Picking a manual folder then dropping/selecting audio should create the workspace inside that folder, not the default.

**Step 8: Commit**

```bash
git add ui/src/components/LandingHub.tsx
git commit -m "feat(landing): add Advanced Manual Folder toggle with per-run override"
```

---

## Verification Checklist (after all tasks complete)

Run full compile + lint:
```bash
cd ui && npx tsc --noEmit && npm run lint
```

Manual flow validation in `npm run tauri:wsl`:
1. Delete `data/config.json` → restart → first-run modal appears, folder picker works, landing page appears after save.
2. Drop an audio file → workspace subfolder created in default dir, file copied in, pipeline can be run.
3. "Change" link in header → opens picker → config updates immediately.
4. Enable "Advanced: Manual Folder" → pick a different dir → drop audio → workspace created in override dir.
5. Collapse advanced toggle → `manualOverrideDir` resets → next run uses default dir.
