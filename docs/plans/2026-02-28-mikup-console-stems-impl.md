# MikupConsole, Canonical Stems & DSP Persistence Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor the Mikup frontend to show a cinematic terminal console during processing, use canonical stem names (DX/Music/Foley/SFX/Ambience), persist DSP metrics to disk, and fix the Invalid Date display bug.

**Architecture:** Four independent concerns touched in order — Rust bridge first (add `write_dsp_metrics` command), then types/stem resolution, then App.tsx wiring, then new MikupConsole component replacing the static stage checklist. Each concern is self-contained and testable in isolation.

**Tech Stack:** React 18, TypeScript, Tauri 2 (Rust), `@tauri-apps/api`, `lucide-react`, Tailwind CSS with `clsx`.

---

### Task 1: Add `write_dsp_metrics` Tauri Command (Rust)

**Files:**
- Modify: `ui/src-tauri/src/lib.rs`

**Step 1: Add the command function**

After the `mark_dsp_complete` function (around line 554), insert:

```rust
/// Persist the integrated LUFS and LRA produced by `stream_audio_metrics` to disk.
/// Written to `{output_directory}/data/dsp_metrics.json` so the Python backend can
/// read it during Stage 5 (AI Director report generation).
#[tauri::command]
async fn write_dsp_metrics(
    output_directory: String,
    dialogue_integrated_lufs: f32,
    dialogue_loudness_range_lu: f32,
    background_integrated_lufs: f32,
    background_loudness_range_lu: f32,
) -> Result<(), String> {
    let metrics_path = resolve_data_artifact_path(&output_directory, "dsp_metrics.json")?;

    let metrics = serde_json::json!({
        "dialogue_integrated_lufs": dialogue_integrated_lufs,
        "dialogue_loudness_range_lu": dialogue_loudness_range_lu,
        "background_integrated_lufs": background_integrated_lufs,
        "background_loudness_range_lu": background_loudness_range_lu,
    });

    let serialized = serde_json::to_string_pretty(&metrics).map_err(|e| e.to_string())?;

    // Ensure the data directory exists (workspace setup normally creates it, but be safe).
    if let Some(parent) = metrics_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create data directory: {e}"))?;
    }

    tokio::fs::write(&metrics_path, serialized)
        .await
        .map_err(|e| format!("Failed to write dsp_metrics.json: {e}"))
}
```

**Step 2: Register the command in `invoke_handler!`**

Find the `tauri::generate_handler![` block (around line 901) and add `write_dsp_metrics` to the list:

```rust
.invoke_handler(tauri::generate_handler![
    process_audio,
    run_pipeline_stage,
    read_output_payload,
    get_stems,
    get_history,
    get_app_config,
    set_default_projects_dir,
    setup_project_workspace,
    get_pipeline_state,
    stream_audio_metrics,
    stop_dsp_stream,
    mark_dsp_complete,
    write_dsp_metrics,   // ← add this
    send_agent_message,
])
```

**Step 3: Verify the Rust compiles**

```bash
cd ui && cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | tail -20
```

Expected: no errors. Warnings are fine.

**Step 4: Commit**

```bash
cd ui
git add src-tauri/src/lib.rs
git commit -m "feat(rust): add write_dsp_metrics Tauri command"
```

---

### Task 2: Update Canonical Stem Names in `types.ts`

**Files:**
- Modify: `ui/src/types.ts`

**Step 1: Update `deriveStemPathsFromSource`**

Find the function starting at line 233. Replace the return array:

```typescript
function deriveStemPathsFromSource(sourceFile: string): string[] {
  const filename = sourceFile.replace(/^.*[\\/]/, '');
  const baseName = filename.replace(/\.[^/.]+$/, '');
  if (!baseName) return [];
  return [
    `${baseName}_DX.wav`,
    `${baseName}_Music.wav`,
    `${baseName}_Foley.wav`,
    `${baseName}_SFX.wav`,
    `${baseName}_Ambience.wav`,
  ];
}
```

**Step 2: Sort DX-first in `resolveStemAudioSources`**

At the end of `resolveStemAudioSources`, before `return Array.from(stemPaths)`, add sort:

```typescript
export function resolveStemAudioSources(payload: MikupPayload | null): string[] {
  if (!payload) return [];

  const outputDir = payload.artifacts?.output_dir;
  const stemPaths = new Set<string>();

  for (const path of payload.artifacts?.stem_paths ?? []) {
    const trimmed = path.trim();
    if (!trimmed || !isLikelyLocalPath(trimmed)) continue;
    stemPaths.add(resolveToAbsolute(trimmed, outputDir));
  }

  if (stemPaths.size === 0 && payload.metadata?.source_file) {
    const stemsDir = outputDir ? `${outputDir}/stems` : undefined;
    for (const path of deriveStemPathsFromSource(payload.metadata.source_file)) {
      stemPaths.add(resolveToAbsolute(path, stemsDir));
    }
  }

  // DX stem is primary — sort it first so WaveformVisualizer loads it as the default waveform.
  return Array.from(stemPaths).sort((a, b) => {
    const aIsDX = /_DX\./i.test(a);
    const bIsDX = /_DX\./i.test(b);
    if (aIsDX && !bIsDX) return -1;
    if (!aIsDX && bIsDX) return 1;
    return 0;
  });
}
```

**Step 3: Run TypeScript check**

```bash
cd ui && npm run lint 2>&1 | head -40
```

Expected: no new errors from types.ts.

**Step 4: Commit**

```bash
git add ui/src/types.ts
git commit -m "feat(types): update to canonical stem names (DX/Music/Foley/SFX/Ambience)"
```

---

### Task 3: Clean Up `App.tsx` — Stem Resolution, Date Fix, DSP Persistence

**Files:**
- Modify: `ui/src/App.tsx`

**Step 1: Remove the redundant `deriveStemPaths` function**

Delete lines 47–62 (the `deriveStemPaths` function and its JSDoc comment) entirely.

**Step 2: Update `resolvePlaybackStemPaths` to use canonical patterns**

Replace the entire function body:

```typescript
function resolvePlaybackStemPaths(
  payload: MikupPayload | null,
  inputPath: string | null,
  workspaceDirectory: string | null,
): [string, string] {
  const stems = payload?.artifacts?.stem_paths ?? [];

  // Prefer canonical stem names from the payload artifacts.
  const payloadDX = stems.find((p) => /_DX\./i.test(p));
  const payloadMusic = stems.find((p) => /_Music\./i.test(p));

  if (payloadDX && payloadMusic) {
    return [payloadDX, payloadMusic];
  }

  // Fallback: derive paths from workspace + input filename.
  if (inputPath && workspaceDirectory) {
    const filename = inputPath.replace(/^.*[\\/]/, '');
    const baseName = filename.replace(/\.[^/.]+$/, '');
    return [
      `${workspaceDirectory}/stems/${baseName}_DX.wav`,
      `${workspaceDirectory}/stems/${baseName}_Music.wav`,
    ];
  }

  return [stems[0] ?? '', stems[1] ?? ''];
}
```

**Step 3: Fix the Invalid Date display**

Find the analysis header span (around line 709):
```tsx
{new Date(payload?.metadata?.timestamp || '').toLocaleDateString()}
```

Replace with:
```tsx
{payload?.metadata?.timestamp
  ? new Date(payload.metadata.timestamp).toLocaleDateString()
  : '—'}
```

**Step 4: Invoke `write_dsp_metrics` in the DSP complete `useEffect`**

In the `useEffect` watching `dspStream.completePayload` (around line 158), after the existing `mark_dsp_complete` invoke block, add:

```typescript
// Persist LUFS/LRA to disk so Python Stage 5 can read them.
if (workspaceDirectory) {
  invoke<void>('write_dsp_metrics', {
    outputDirectory: workspaceDirectory,
    dialogueIntegratedLufs: complete.dialogue_integrated_lufs,
    dialogueLoudnessRangeLu: complete.dialogue_loudness_range_lu,
    backgroundIntegratedLufs: complete.background_integrated_lufs,
    backgroundLoudnessRangeLu: complete.background_loudness_range_lu,
  }).catch(() => {
    // Non-fatal — AI Director will skip LUFS context if file is missing.
  });
}
```

**Step 5: Lint check**

```bash
cd ui && npm run lint 2>&1 | head -40
```

Expected: no new errors.

**Step 6: Commit**

```bash
git add ui/src/App.tsx
git commit -m "fix(app): canonical stem resolution, Invalid Date header, write_dsp_metrics on DSP complete"
```

---

### Task 4: Create `MikupConsole` Component

**Files:**
- Create: `ui/src/components/MikupConsole.tsx`

**Step 1: Create the file**

```typescript
import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';

interface ConsoleEntry {
  id: number;
  stage: string;
  message: string;
  progress: number;
  timestamp: string;
}

interface StageStyle {
  color: string;
  emoji: string;
  label: string;
}

const STAGE_STYLES: Record<string, StageStyle> = {
  SEPARATION: { color: 'text-fuchsia-400', emoji: '📽️', label: 'CINEMA' },
  CINEMA:     { color: 'text-fuchsia-400', emoji: '📽️', label: 'CINEMA' },
  VOX:        { color: 'text-cyan-400',    emoji: '💎', label: 'VOX'    },
  DX:         { color: 'text-cyan-400',    emoji: '💎', label: 'DX'     },
  DIALOGUE:   { color: 'text-cyan-400',    emoji: '💎', label: 'DX'     },
  DSP:        { color: 'text-blue-400',    emoji: '📊', label: 'DSP'    },
  TRANSCRIPTION: { color: 'text-green-400', emoji: '📝', label: 'TRANSCRIPTION' },
  FX:         { color: 'text-amber-400',   emoji: '⚡', label: 'FX'     },
  SFX:        { color: 'text-amber-400',   emoji: '⚡', label: 'SFX'    },
  AMBIENCE:   { color: 'text-violet-400',  emoji: '🌊', label: 'AMB'    },
  FOLEY:      { color: 'text-yellow-300',  emoji: '👣', label: 'FOLEY'  },
  COMPLETE:   { color: 'text-emerald-400', emoji: '✓',  label: 'DONE'   },
};

function resolveStageStyle(stage: string): StageStyle {
  const key = stage.toUpperCase().trim();
  return (
    STAGE_STYLES[key] ??
    Object.entries(STAGE_STYLES).find(([k]) => key.startsWith(k))?.[1] ??
    { color: 'text-zinc-400', emoji: '·', label: key || '···' }
  );
}

function formatTimestamp(): string {
  const now = new Date();
  return [
    now.getHours().toString().padStart(2, '0'),
    now.getMinutes().toString().padStart(2, '0'),
    now.getSeconds().toString().padStart(2, '0'),
  ].join(':');
}

export function MikupConsole() {
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const counterRef = useRef(0);

  useEffect(() => {
    const unlisten = listen<{ stage: string; progress: number; message: string }>(
      'process-status',
      (event) => {
        const { stage, progress, message } = event.payload;
        if (!message.trim()) return;
        setEntries((prev) => [
          ...prev,
          {
            id: ++counterRef.current,
            stage,
            message,
            progress,
            timestamp: formatTimestamp(),
          },
        ]);
      },
    );
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // Auto-scroll to bottom on new entries.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries]);

  return (
    <div
      className="w-full h-full overflow-y-auto rounded select-text"
      style={{ background: '#0a0a0a', fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace" }}
    >
      {entries.length === 0 ? (
        <div className="flex items-center justify-center h-full">
          <span className="text-[11px] text-zinc-600 uppercase tracking-widest animate-pulse">
            Awaiting pipeline output…
          </span>
        </div>
      ) : (
        <div className="p-3 space-y-0.5">
          {entries.map((entry) => {
            const style = resolveStageStyle(entry.stage);
            return (
              <div key={entry.id} className="flex items-baseline gap-2 leading-5">
                <span className="text-[9px] text-zinc-600 tabular-nums shrink-0 w-[46px]">
                  {entry.timestamp}
                </span>
                <span className={`text-[10px] font-bold shrink-0 w-[72px] ${style.color}`}>
                  [{style.label}]
                </span>
                <span className="text-[10px] shrink-0">{style.emoji}</span>
                <span className="text-[11px] text-zinc-300 flex-1 min-w-0 break-words">
                  {entry.message}
                </span>
                {entry.progress > 0 && entry.progress < 100 && (
                  <span className="text-[9px] text-zinc-500 tabular-nums shrink-0 ml-auto">
                    {entry.progress}%
                  </span>
                )}
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
```

**Step 2: Lint check**

```bash
cd ui && npm run lint 2>&1 | head -40
```

Expected: no errors.

**Step 3: Commit**

```bash
git add ui/src/components/MikupConsole.tsx
git commit -m "feat(ui): add MikupConsole terminal log component"
```

---

### Task 5: Integrate MikupConsole into the Processing View (`App.tsx`)

**Files:**
- Modify: `ui/src/App.tsx`

**Step 1: Import MikupConsole**

Add to the import block at the top of `App.tsx`:

```typescript
import { MikupConsole } from './components/MikupConsole';
```

**Step 2: Remove the existing `process-status` listener in `App.tsx`**

The `useEffect` at line 119 that calls `listen<ProgressStatus>('process-status', ...)` was previously needed to populate the `progress` state for the progress bar. MikupConsole now owns that subscription. However, `App.tsx` still uses `progress.progress` for the progress bar at the bottom of the processing view. Keep the existing listener — `MikupConsole` will register its own second listener independently (Tauri supports multiple listeners on the same event).

No removal needed — both can coexist.

**Step 3: Replace the stage checklist with `MikupConsole` inside the processing view**

Find the stage checklist block in the `processing` view (the `view === 'processing'` JSX branch), specifically the block that renders when `runningStageIndex !== DSP_STAGE_INDEX` — the `div.space-y-3` containing `PIPELINE_STAGES.map(...)`. Replace that block with the console:

The current structure is:
```tsx
{runningStageIndex === DSP_STAGE_INDEX ? (
  /* Live metering view */
  ...
) : (
  <div className="space-y-3">
    {PIPELINE_STAGES.map(...)}
  </div>
)}
```

Replace the `else` branch with a two-part layout: stage dots on top, console below:

```tsx
) : (
  <div className="space-y-3">
    {/* Stage progress dots */}
    <div className="flex items-center gap-3">
      {PIPELINE_STAGES.map((stage, i) => {
        const isComplete = i < completedStageCount;
        const isRunning = i === runningStageIndex;
        const isReady = i === completedStageCount && runningStageIndex === null;
        return (
          <div key={stage.id} className="flex items-center gap-1.5">
            <div
              className="w-1.5 h-1.5 rounded-full"
              style={{
                backgroundColor:
                  isComplete || isRunning || isReady
                    ? 'var(--color-accent)'
                    : 'var(--color-panel-border)',
              }}
            />
            <span className={`text-[10px] font-mono ${isRunning || isReady ? 'text-text-main' : 'text-text-muted opacity-50'}`}>
              {stage.label}
            </span>
            {isComplete && (
              <button
                type="button"
                onClick={() => handleRerunStage(i)}
                disabled={runningStageIndex !== null}
                className="text-[9px] font-mono text-text-muted hover:text-accent transition-colors disabled:opacity-40 ml-1"
              >
                re-run
              </button>
            )}
          </div>
        );
      })}
    </div>

    {/* Cinematic console */}
    <div className="h-52 border border-panel-border overflow-hidden rounded">
      <MikupConsole />
    </div>
  </div>
)}
```

**Step 4: Lint check**

```bash
cd ui && npm run lint 2>&1 | head -40
```

Expected: no errors.

**Step 5: Commit**

```bash
git add ui/src/App.tsx
git commit -m "feat(app): integrate MikupConsole into processing view, replace stage checklist"
```

---

### Task 6: Update MetricsPanel Stream Labels

**Files:**
- Modify: `ui/src/components/MetricsPanel.tsx`

**Step 1: Update `StreamToggle` labels and tooltip rows to use canonical names**

Find the three `<StreamToggle` usages (around lines 141–161) and update labels:

```tsx
<StreamToggle
  label="DX"                         // was "Dialogue"
  color="oklch(0.7 0.12 260)"
  isActive={activeStreams.has('diagST')}
  onClick={() => toggleStream('diagST')}
/>
<StreamToggle
  label="Music"                      // was "Background"
  color="oklch(0.7 0.12 150)"
  isActive={activeStreams.has('bgST')}
  onClick={() => toggleStream('bgST')}
/>
```

**Step 2: Update `TooltipRow` labels inside `CustomTooltip`**

```tsx
<TooltipRow label="DX" value={data.diagST} color="oklch(0.7 0.12 260)" />
<TooltipRow label="Music" value={data.bgST} color="oklch(0.7 0.12 150)" />
```

**Step 3: Lint check**

```bash
cd ui && npm run lint 2>&1 | head -40
```

**Step 4: Commit**

```bash
git add ui/src/components/MetricsPanel.tsx
git commit -m "fix(metrics): update stream toggle labels to canonical DX/Music naming"
```

---

### Task 7: Final Verification

**Step 1: Full lint pass**

```bash
cd ui && npm run lint
```

Expected: exit 0, no errors.

**Step 2: Dev build check**

```bash
cd ui && npm run dev &
# Let it start, then check for any TypeScript compilation errors in the terminal output
```

Kill with Ctrl+C when done.

**Step 3: Smoke-test the console (dev mode)**

Open the app, start a new process. During stage execution, the console should appear below the stage dots and stream colored log lines.

**Step 4: Final commit (if anything was missed)**

```bash
git add -p  # review any remaining changes
git commit -m "chore: final lint/type cleanup for MikupConsole & canonical stems"
```
