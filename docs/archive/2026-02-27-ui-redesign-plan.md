# UI Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign the Mikup desktop UI to a flat editorial + data-dense aesthetic — no decorative chrome, all key numbers visible in a single stats bar, sections divided by hairlines only.

**Architecture:** Styling changes across all UI components. `DiagnosticMeters` is replaced by a new `StatsBar` component. No logic changes — data flow stays identical. The `.panel` CSS class loses its background/shadow/radius and becomes a borderless transparent container; section dividers are `border-t` hairlines only.

**Tech Stack:** React, TypeScript, Tailwind CSS v4 (via `@theme` in `index.css`), Recharts, WaveSurfer.js, Tauri.

**Design doc:** `docs/plans/2026-02-27-ui-redesign-design.md`

---

## Verification approach

Since this project has no frontend unit tests, each task uses:
1. `npm run lint` (from `ui/`) — catches TypeScript/ESLint errors
2. `npm run dev` (from `ui/`) — visual verification in browser at `http://localhost:5173`
3. Commit when it looks right

All `npm` commands must be run from the `ui/` directory.

---

### Task 1: Strip CSS theme

**Goal:** Remove decorative variables and utility classes. Update accent to a stronger blue. Redefine `.panel` as transparent with no shadow or radius.

**Files:**
- Modify: `ui/src/index.css` (full file)
- Modify: `ui/src/App.css` (clear boilerplate)

**Step 1: Replace `ui/src/index.css` entirely**

```css
@import "tailwindcss";

@theme {
  --color-background: oklch(0.98 0.005 250);
  --color-panel: transparent;
  --color-panel-border: oklch(0.88 0.01 250);
  --color-accent: oklch(0.45 0.15 260);
  --color-text-main: oklch(0.15 0.01 250);
  --color-text-muted: oklch(0.5 0.01 250);

  --font-mono: "JetBrains Mono", "Fira Code", monospace;
  --font-sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}

body {
  background-color: var(--color-background);
  color: var(--color-text-main);
  margin: 0;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  font-family: var(--font-sans);
}

::-webkit-scrollbar {
  width: 4px;
  height: 4px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: var(--color-panel-border);
  border-radius: 2px;
}

::-webkit-scrollbar-thumb:hover {
  background: var(--color-text-muted);
}

/* Panel is now just a transparent container — no background, no shadow, no radius */
.panel {
  background-color: transparent;
  border: none;
}
```

**Step 2: Clear `ui/src/App.css`**

Replace the entire file with just a comment (it's Vite boilerplate, nothing in the app uses it):

```css
/* App-level styles — kept empty, global styles live in index.css */
```

**Step 3: Lint**

```bash
cd ui && npm run lint
```

Expected: No errors. (CSS changes don't affect lint.)

**Step 4: Commit**

```bash
cd ui && git add src/index.css src/App.css
git commit -m "style: strip decorative CSS theme, redefine panel as transparent"
```

---

### Task 2: Redesign LandingHub

**Goal:** Remove the `FeatureCard` component and the feature cards grid. Remove the tagline. Compact the drop zone from `h-96` to `h-28`. Flatten history item rows.

**Files:**
- Modify: `ui/src/components/LandingHub.tsx`

**Step 1: Rewrite `LandingHub.tsx`**

Replace the entire file with:

```tsx
import React, { useState, useEffect } from 'react';
import { FileAudio, ChevronRight, Search } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import type { HistoryEntry, MikupPayload } from '../types';
import { clsx } from 'clsx';

interface LandingHubProps {
  onSelectProject: (payload: MikupPayload) => void;
  onStartNewProcess: (filePath: string) => void;
  isProcessing: boolean;
}

export const LandingHub: React.FC<LandingHubProps> = ({
  onSelectProject,
  onStartNewProcess,
  isProcessing,
}) => {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const loadHistory = async () => {
    try {
      const data = await invoke<HistoryEntry[]>('get_history');
      setHistory(data);
    } catch (err) {
      console.error('Failed to load history:', err);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadHistory();
  }, []);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => setIsDragging(false);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    const audioFile = files.find(f =>
      f.name.endsWith('.wav') || f.name.endsWith('.mp3') || f.name.endsWith('.flac')
    );
    if (audioFile && !isProcessing) {
      onStartNewProcess(audioFile.name);
    }
  };

  const filteredHistory = history.filter(item =>
    item.filename.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="max-w-3xl mx-auto px-6 py-10 animate-in fade-in duration-500">
      <header className="mb-8 flex items-baseline justify-between">
        <h1 className="text-xl font-semibold tracking-tight text-text-main">Mikup</h1>
        <span className="text-[11px] font-mono text-text-muted">v0.1.0-alpha</span>
      </header>

      <div className="border-t border-panel-border pt-6 mb-2">
        <p className="text-[10px] uppercase tracking-widest font-bold text-text-muted mb-3">
          Drop an audio file to begin &nbsp;·&nbsp; .wav .mp3 .flac
        </p>
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={clsx(
            "h-28 border border-dashed flex items-center justify-center transition-colors duration-200 cursor-default select-none",
            isDragging
              ? "border-accent bg-accent/5 text-accent"
              : "border-panel-border text-text-muted hover:border-accent/50 hover:text-accent/70",
            isProcessing && "opacity-40 pointer-events-none"
          )}
        >
          <span className="text-sm">
            {isProcessing ? 'Processing...' : 'Drag & drop or click to select'}
          </span>
        </div>
      </div>

      <div className="border-t border-panel-border pt-6 mt-8">
        <div className="flex items-center justify-between mb-4">
          <p className="text-[10px] uppercase tracking-widest font-bold text-text-muted">Recent</p>
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              type="text"
              placeholder="Search..."
              className="bg-transparent border border-panel-border pl-7 pr-3 py-1 text-xs focus:outline-none focus:border-accent transition-colors"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-px">
          {filteredHistory.length > 0 ? (
            filteredHistory.map((entry) => (
              <button
                key={entry.id}
                onClick={() => onSelectProject(entry.payload)}
                className="w-full group text-left flex items-center gap-4 py-2.5 px-1 border-b border-panel-border hover:bg-accent/5 transition-colors"
              >
                <FileAudio size={14} className="text-text-muted shrink-0" />
                <span className="flex-1 text-sm text-text-main font-mono truncate">
                  {entry.filename}
                </span>
                <span className="text-[11px] font-mono text-text-muted tabular-nums">
                  {new Date(entry.date).toLocaleDateString()}
                </span>
                <span className="text-[11px] font-mono text-text-muted tabular-nums">
                  {(entry.duration / 60).toFixed(1)}m
                </span>
                <ChevronRight size={12} className="text-text-muted opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
            ))
          ) : (
            <p className="text-sm text-text-muted py-6">No history found.</p>
          )}
        </div>
      </div>
    </div>
  );
};
```

**Step 2: Lint and verify**

```bash
cd ui && npm run lint
```

Expected: No errors.

Start dev server and check landing page at `http://localhost:5173`:
- No feature cards
- Compact drop zone (~112px tall)
- Flat history rows with filename / date / duration
- No tagline

**Step 3: Commit**

```bash
cd ui && git add src/components/LandingHub.tsx
git commit -m "feat: simplify landing — remove feature cards, compact drop zone, flat history rows"
```

---

### Task 3: Replace DiagnosticMeters with StatsBar

**Goal:** Delete the SVG gauge implementation. Create a new `StatsBar` component that shows all five key stats (SNR, Correlation, Balance, Gaps, Integrated LUFS) as flat data rows in a single horizontal bar.

**Files:**
- Modify: `ui/src/components/DiagnosticMeters.tsx` (full rewrite — keep filename, rename export)

**Step 1: Rewrite `DiagnosticMeters.tsx`**

```tsx
import React from 'react';
import type { DiagnosticMetrics } from '../types';

interface StatsBarProps {
  metrics: DiagnosticMetrics;
  gapCount: number;
  integratedLufs: number | null;
}

export const StatsBar: React.FC<StatsBarProps> = ({ metrics, gapCount, integratedLufs }) => {
  return (
    <div className="border-t border-b border-panel-border py-4 grid grid-cols-2 md:grid-cols-5 gap-x-6 gap-y-4">
      <StatCell
        label="SNR"
        value={metrics.intelligibility_snr}
        unit="dB"
        min={-10}
        max={40}
        interpret={interpretSnr(metrics.intelligibility_snr)}
      />
      <StatCell
        label="Phase Correlation"
        value={metrics.stereo_correlation}
        unit=""
        min={-1}
        max={1}
        interpret={interpretCorr(metrics.stereo_correlation)}
      />
      <StatCell
        label="Stereo Balance"
        value={metrics.stereo_balance}
        unit=""
        min={-1}
        max={1}
        interpret={interpretBalance(metrics.stereo_balance)}
      />
      <StatCell
        label="Gaps Detected"
        value={gapCount}
        unit=""
        min={0}
        max={100}
        interpret=""
        hideBar
      />
      <StatCell
        label="Integrated LUFS"
        value={integratedLufs ?? 0}
        unit="LUFS"
        min={-48}
        max={0}
        interpret={integratedLufs !== null ? '' : 'N/A'}
        hideBar={integratedLufs === null}
      />
    </div>
  );
};

interface StatCellProps {
  label: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  interpret: string;
  hideBar?: boolean;
}

const StatCell: React.FC<StatCellProps> = ({ label, value, unit, min, max, interpret, hideBar }) => {
  const pct = Math.max(0, Math.min(1, (value - min) / (max - min)));

  return (
    <div className="flex flex-col gap-1">
      <span className="text-[9px] uppercase tracking-widest font-bold text-text-muted">{label}</span>
      <span className="font-mono text-xl font-semibold text-text-main tabular-nums leading-none">
        {typeof value === 'number' ? value.toFixed(value % 1 === 0 ? 0 : 2) : '--'}
        {unit && <span className="text-xs font-normal text-text-muted ml-1">{unit}</span>}
      </span>
      {!hideBar && (
        <div className="h-px w-full bg-panel-border relative mt-1">
          <div
            className="absolute top-0 left-0 h-px bg-accent transition-all duration-700"
            style={{ width: `${pct * 100}%` }}
          />
        </div>
      )}
      {interpret && (
        <span className="text-[9px] text-text-muted font-medium mt-0.5">{interpret}</span>
      )}
    </div>
  );
};

function interpretSnr(v: number) {
  if (v > 25) return 'Excellent Clarity';
  if (v > 15) return 'Clear Dialogue';
  if (v > 5) return 'Competitive Mix';
  return 'Poor Separation';
}

function interpretCorr(v: number) {
  if (v > 0.8) return 'Strong Mono Compat.';
  if (v > 0.3) return 'Healthy Stereo';
  if (v >= 0) return 'Wide Field';
  return 'Phase Issues';
}

function interpretBalance(v: number) {
  if (Math.abs(v) < 0.1) return 'Centered';
  if (v > 0) return 'Biased Right';
  return 'Biased Left';
}
```

**Step 2: Lint**

```bash
cd ui && npm run lint
```

Expected: No errors. (The component won't be rendered yet until App.tsx is updated in Task 4.)

**Step 3: Commit**

```bash
cd ui && git add src/components/DiagnosticMeters.tsx
git commit -m "feat: replace SVG gauge meters with flat StatsBar component"
```

---

### Task 4: Update App.tsx — analysis layout, StatsBar, terminology, flat header

**Goal:** Wire in `StatsBar`. Flatten the analysis view header. Replace `.panel` section wrappers with `border-t` hairlines. Update all terminology ("Mikups" → "Gaps", "Surgical Timeline" → "Timeline", "AI Director Report" → "Analysis Report"). Reduce padding.

**Files:**
- Modify: `ui/src/App.tsx`

**Step 1: Update imports**

Find the import line for `DiagnosticMeters`:
```tsx
import { DiagnosticMeters } from './components/DiagnosticMeters';
```

Change to:
```tsx
import { StatsBar } from './components/DiagnosticMeters';
```

Also remove the `Radio` icon import (no longer used in the error toast) and `CheckCircle2`, `Circle` if they'll be simplified in the processing screen. Keep `Loader2`, `ArrowLeft`.

Updated import line:
```tsx
import { ArrowLeft, Loader2 } from 'lucide-react';
```

**Step 2: Update the processing screen (view === 'processing')**

Replace the processing screen return with a stripped-down version:

```tsx
if (view === 'processing') {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-8">
      <div className="max-w-sm w-full space-y-8 animate-in fade-in duration-500">
        <div>
          <p className="text-[10px] uppercase tracking-widest font-bold text-text-muted mb-1">Processing</p>
          <h2 className="text-2xl font-semibold text-text-main">Analyzing audio</h2>
        </div>

        <div className="space-y-3">
          {PIPELINE_STAGES.map((stage, i) => {
            const stageIndex = PIPELINE_STAGES.findIndex(s => s.id === progress.stage);
            const isDone = stageIndex > i || progress.stage === 'COMPLETE';
            const isCurrent = progress.stage === stage.id;

            return (
              <div key={stage.id} className={clsx(
                "flex items-center gap-3 transition-opacity duration-300",
                !isDone && !isCurrent && "opacity-30"
              )}>
                <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{
                  backgroundColor: isDone || isCurrent ? 'var(--color-accent)' : 'var(--color-panel-border)'
                }} />
                <span className={clsx(
                  "text-sm transition-colors",
                  isCurrent ? "text-text-main font-medium" : "text-text-muted"
                )}>
                  {stage.label}
                </span>
                {isCurrent && (
                  <Loader2 size={12} className="animate-spin text-accent ml-auto" />
                )}
              </div>
            );
          })}
        </div>

        <div>
          <div className="w-full h-px bg-panel-border relative">
            <div
              className="absolute top-0 left-0 h-px bg-accent transition-all duration-700 ease-out"
              style={{ width: `${progress.progress}%` }}
            />
          </div>
          <div className="flex justify-between mt-2 text-[10px] font-mono text-text-muted">
            <span>Progress</span>
            <span>{progress.progress}%</span>
          </div>
        </div>

        {pipelineErrors.length > 0 && (
          <div className="max-h-28 overflow-y-auto space-y-1 border-t border-panel-border pt-3">
            {pipelineErrors.map((msg, i) => (
              <p key={i} className="text-[10px] font-mono text-red-500">{msg}</p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

**Step 3: Update the analysis view return**

Replace the entire analysis view `return (...)` with:

```tsx
return (
  <div className="min-h-screen flex flex-col bg-background text-text-main animate-in fade-in duration-500">
    {/* Header */}
    <header className="flex items-center justify-between px-6 py-4 border-b border-panel-border">
      <div className="flex items-center gap-4">
        <button
          onClick={() => setView('landing')}
          className="text-text-muted hover:text-accent transition-colors"
        >
          <ArrowLeft size={16} />
        </button>
        <div>
          <span className="text-sm font-mono font-medium text-text-main">
            {payload?.metadata?.source_file.split(/[\\/]/).pop()}
          </span>
          <span className="text-[11px] font-mono text-text-muted ml-4">
            {new Date(payload?.metadata?.timestamp || '').toLocaleDateString()}
            &nbsp;·&nbsp;
            v{payload?.metadata?.pipeline_version}
          </span>
        </div>
      </div>
      <span className="text-[10px] uppercase tracking-widest font-bold text-text-muted">
        Analysis Result
      </span>
    </header>

    {/* Stats Bar */}
    <div className="px-6 py-4">
      {payload?.metrics?.diagnostic_meters && (
        <StatsBar
          metrics={payload.metrics.diagnostic_meters}
          gapCount={payload?.metrics?.pacing_gaps?.length ?? 0}
          integratedLufs={payload?.metrics?.lufs_graph?.dialogue_raw?.integrated ?? null}
        />
      )}
    </div>

    {/* Main grid */}
    <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 min-h-0">
      {/* Left column */}
      <div className="lg:col-span-8 flex flex-col border-r border-panel-border">
        {/* Timeline */}
        <section className="flex flex-col px-6 py-5 border-b border-panel-border" style={{ height: '360px' }}>
          <div className="flex items-center justify-between mb-4">
            <span className="text-[10px] uppercase tracking-widest font-bold text-text-muted">Timeline</span>
            <span className="text-[10px] font-mono text-text-muted">
              {payload?.metrics?.pacing_gaps?.length ?? 0} gaps detected
            </span>
          </div>
          <div className="flex-1 min-h-0">
            <WaveformVisualizer
              pacing={payload?.metrics?.pacing_gaps}
              duration={payload?.metrics?.spatial_metrics?.total_duration}
              audioSources={resolveStemAudioSources(payload)}
            />
          </div>
        </section>

        {/* Loudness Analysis */}
        <section className="flex-1 px-6 py-5 min-h-[360px]">
          <MetricsPanel payload={payload!} />
        </section>
      </div>

      {/* Right column — Analysis Report */}
      <aside className="lg:col-span-4 flex flex-col px-6 py-5">
        <span className="text-[10px] uppercase tracking-widest font-bold text-text-muted mb-4">
          Analysis Report
        </span>
        <div className="flex-1 flex flex-col min-h-0">
          <DirectorChat
            key={`${payload?.metadata?.source_file ?? 'none'}:${payload?.ai_report ?? 'none'}`}
            payload={payload}
          />
        </div>
      </aside>
    </div>

    {error && (
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        {error}
      </div>
    )}
  </div>
);
```

**Step 4: Update the landing error toast**

In the landing view return, replace the error toast:
```tsx
{error && (
  <div className="fixed bottom-6 left-1/2 -translate-x-1/2 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
    {error}
  </div>
)}
```

**Step 5: Check for `pacing_gaps` vs `pacing_mikups` in types**

The types file references `pacing_mikups`. The `StatsBar` and the analysis view above use `pacing_gaps`. Check `ui/src/types.ts` and update the field name there if needed, OR keep using `pacing_mikups` in the code (it's just a data key, not a UI label). Use whichever name the type already has — only the displayed text label changes to "gaps".

If `types.ts` uses `pacing_mikups`, revert `payload?.metrics?.pacing_gaps` back to `payload?.metrics?.pacing_mikups` in App.tsx and StatsBar. The displayed text still says "gaps detected".

**Step 6: Lint**

```bash
cd ui && npm run lint
```

Fix any type errors before continuing.

**Step 7: Visual check**

```bash
cd ui && npm run dev
```

In browser check:
- Flat single-line header (no card/panel box)
- Stats bar shows 5 columns with flat progress lines
- Timeline section has "Timeline" label and "N gaps detected"
- Loudness Analysis section is visible below
- Right column says "Analysis Report"
- Processing screen is plain list with dots and a hairline progress bar

**Step 8: Commit**

```bash
cd ui && git add src/App.tsx
git commit -m "feat: redesign analysis view — flat header, StatsBar, hairline dividers, updated terminology"
```

---

### Task 5: Re-style MetricsPanel

**Goal:** Remove the `.panel` wrapper around the chart. Update section title to "Loudness Analysis". Remove the floating overlay's backdrop blur. Flatten `StreamToggle` buttons.

**Files:**
- Modify: `ui/src/components/MetricsPanel.tsx`

**Step 1: Update the section header**

Find:
```tsx
<h3 className="text-lg font-semibold text-text-main leading-tight">LUFS Laboratory</h3>
<p className="text-[10px] uppercase tracking-widest font-bold text-text-muted">EBU R128 Density Mapping</p>
```

Replace with:
```tsx
<h3 className="text-[10px] uppercase tracking-widest font-bold text-text-muted leading-tight">Loudness Analysis</h3>
```

**Step 2: Remove `.panel` from chart container**

Find:
```tsx
<div className="panel p-6 h-[380px] relative overflow-hidden group">
```

Replace with:
```tsx
<div className="h-[380px] relative overflow-hidden">
```

**Step 3: Flatten the floating metrics overlay**

Find:
```tsx
<div className="absolute bottom-6 right-8 flex items-center gap-6 bg-white/60 backdrop-blur-xl px-5 py-3 rounded-2xl border border-panel-border shadow-xl ring-1 ring-black/[0.03]">
```

Replace with:
```tsx
<div className="absolute bottom-4 right-2 flex items-center gap-5 bg-background/90 px-4 py-2 border border-panel-border">
```

**Step 4: Remove the Laboratory Note block entirely**

Delete the entire `<div>` block containing "Laboratory Note:" (lines ~232–241). It's explanatory filler.

**Step 5: Flatten `StreamToggle` buttons**

Find the `StreamToggle` component:
```tsx
const StreamToggle: React.FC<...> = ({ label, color, isActive, onClick }) => (
  <button
    ...
    className={clsx(
      "px-3 py-1.5 rounded-xl border text-[10px] font-black uppercase tracking-widest transition-all duration-500 flex items-center gap-2",
      isActive
        ? "bg-white shadow-md border-panel-border scale-105"
        : "opacity-30 grayscale border-transparent hover:opacity-100 hover:grayscale-0"
    )}
    ...
  >
```

Replace with:
```tsx
const StreamToggle: React.FC<{ label: string; color: string; isActive: boolean; onClick: () => void }> = ({
  label, color, isActive, onClick
}) => (
  <button
    onClick={onClick}
    className={clsx(
      "px-2.5 py-1 border text-[9px] font-bold uppercase tracking-widest transition-colors flex items-center gap-1.5",
      isActive
        ? "border-panel-border text-text-main"
        : "border-transparent text-text-muted opacity-40 hover:opacity-70"
    )}
    style={{ color: isActive ? color : undefined }}
  >
    <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />
    {label}
  </button>
);
```

**Step 6: Flatten the tooltip**

Find `CustomTooltip`:
```tsx
<div className="bg-white/95 backdrop-blur-2xl border border-panel-border p-4 rounded-2xl shadow-2xl ring-1 ring-black/[0.05] space-y-3">
```

Replace with:
```tsx
<div className="bg-background border border-panel-border p-3 space-y-2">
```

**Step 7: Lint and verify**

```bash
cd ui && npm run lint
```

Check in browser:
- "Loudness Analysis" heading (small uppercase)
- Chart container has no card background
- Stream toggle buttons are flat (no shadow, no rounded)
- Floating overlay is simpler

**Step 8: Commit**

```bash
cd ui && git add src/components/MetricsPanel.tsx
git commit -m "style: flatten MetricsPanel — remove panel card, simplify toggles and overlay"
```

---

### Task 6: Strip decorative chrome from WaveformVisualizer

**Goal:** Flatten the control bar (remove `bg-background border rounded-2xl`). Simplify the loading overlay.

**Files:**
- Modify: `ui/src/components/WaveformVisualizer.tsx`

**Step 1: Flatten the control bar**

Find:
```tsx
<div className="h-16 mt-4 bg-background border border-panel-border rounded-2xl flex items-center justify-between px-6">
```

Replace with:
```tsx
<div className="h-12 mt-3 border-t border-panel-border flex items-center justify-between px-1">
```

**Step 2: Simplify the loading overlay**

Find:
```tsx
<div className="absolute inset-0 flex items-center justify-center bg-background/50 backdrop-blur-sm z-20 rounded-2xl">
  <div className="flex flex-col items-center gap-4">
    <RefreshCcw size={28} className="animate-spin text-accent" />
    <span className="text-xs text-accent uppercase tracking-widest font-bold">Initializing Stems...</span>
  </div>
</div>
```

Replace with:
```tsx
<div className="absolute inset-0 flex items-center justify-center bg-background/70 z-20">
  <span className="text-[10px] font-mono text-text-muted uppercase tracking-widest">Loading...</span>
</div>
```

**Step 3: Simplify the "no source" overlay**

Find:
```tsx
<div className="bg-background/80 px-6 py-3 rounded-2xl border border-panel-border shadow-xl backdrop-blur-md">
  <p className="text-xs text-text-muted uppercase tracking-widest font-bold italic">Awaiting source input...</p>
</div>
```

Replace with:
```tsx
<p className="text-[10px] font-mono text-text-muted uppercase tracking-widest">No audio source</p>
```

**Step 4: Remove unused import**

Remove `RefreshCcw` from the lucide-react import if it's no longer used after step 2:
```tsx
import { Play, Pause } from 'lucide-react';
```

Check the reset button — it uses `RefreshCcw`. If kept, keep the import.

**Step 5: Lint and verify**

```bash
cd ui && npm run lint
cd ui && npm run dev
```

Check: control bar is flat (just a top border), play button still works, no rounded card around the waveform controls.

**Step 6: Commit**

```bash
cd ui && git add src/components/WaveformVisualizer.tsx
git commit -m "style: flatten WaveformVisualizer control bar, simplify overlays"
```

---

### Task 7: Flatten DirectorChat

**Goal:** Remove `rounded-2xl` from chat bubbles. Flatten the message input. Remove decorative `Sparkles`/`User` avatar circles.

**Files:**
- Modify: `ui/src/components/DirectorChat.tsx`

**Step 1: Remove avatar icons**

Find the message rendering block:
```tsx
<div className={`flex gap-4 ${m.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
  <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${...}`}>
    {m.role === 'user' ? <User size={18} /> : <Sparkles size={18} />}
  </div>
  <div className={`max-w-[80%] p-4 rounded-2xl text-[13px] leading-relaxed ${...}`}>
    {m.text}
  </div>
</div>
```

Replace with:
```tsx
<div className={`flex flex-col gap-0.5 ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
  <span className="text-[9px] uppercase tracking-widest font-bold text-text-muted">
    {m.role === 'user' ? 'You' : 'Director'}
  </span>
  <div className={`max-w-[85%] px-3 py-2 text-[13px] leading-relaxed border ${
    m.role === 'user'
      ? 'bg-accent/5 border-accent/20 text-text-main'
      : 'bg-transparent border-panel-border text-text-main'
  }`}>
    {m.text}
  </div>
</div>
```

**Step 2: Flatten the thinking indicator**

Find:
```tsx
{isThinking && (
  <div className="flex gap-4">
    <div className="w-9 h-9 rounded-xl flex items-center justify-center bg-background border border-panel-border text-accent animate-pulse">
      <Sparkles size={18} />
    </div>
    <div className="bg-background border border-panel-border p-4 rounded-2xl rounded-tl-none flex gap-1.5 items-center">
      ...
    </div>
  </div>
)}
```

Replace with:
```tsx
{isThinking && (
  <div className="flex flex-col items-start gap-0.5">
    <span className="text-[9px] uppercase tracking-widest font-bold text-text-muted">Director</span>
    <div className="border border-panel-border px-3 py-2 flex gap-1.5 items-center">
      <span className="w-1.5 h-1.5 bg-accent/40 rounded-full animate-bounce [animation-delay:-0.3s]" />
      <span className="w-1.5 h-1.5 bg-accent/40 rounded-full animate-bounce [animation-delay:-0.15s]" />
      <span className="w-1.5 h-1.5 bg-accent/40 rounded-full animate-bounce" />
    </div>
  </div>
)}
```

**Step 3: Flatten the input**

Find:
```tsx
<input
  ...
  className="w-full bg-background border border-panel-border rounded-xl py-3.5 px-5 pr-14 text-sm transition-all focus:outline-none focus:border-accent focus:ring-4 focus:ring-accent/5 placeholder:text-text-muted/50"
/>
```

Replace with:
```tsx
<input
  ...
  className="w-full bg-transparent border border-panel-border py-2.5 px-4 pr-12 text-sm transition-colors focus:outline-none focus:border-accent placeholder:text-text-muted/40"
/>
```

**Step 4: Remove unused imports**

Remove `User` and `Sparkles` from the lucide-react import:
```tsx
import { Send } from 'lucide-react';
```

**Step 5: Lint and verify**

```bash
cd ui && npm run lint
cd ui && npm run dev
```

Check: Chat bubbles are flat rectangles, no avatar circles, input has no rounded corners.

**Step 6: Commit**

```bash
cd ui && git add src/components/DirectorChat.tsx
git commit -m "style: flatten DirectorChat — remove avatar icons, square chat bubbles"
```

---

### Task 8: Final pass — check for leftover decorative classes

**Goal:** Search for any remaining `rounded-2xl`, `rounded-3xl`, `shadow-`, `backdrop-blur`, `ring-`, hover lift animations that weren't caught in previous tasks.

**Files:** All `ui/src/**/*.tsx`

**Step 1: Search for remaining decorative classes**

```bash
grep -rn "rounded-2xl\|rounded-3xl\|shadow-\|backdrop-blur\|ring-\|translate-y-\[-4px\]" ui/src/
```

For each match, assess whether it's structural (keep) or purely decorative (remove/flatten).

**Step 2: Fix any found instances**

Apply the same pattern: remove `shadow-*`, `backdrop-blur-*`, reduce `rounded-*` to `rounded-sm` or remove entirely.

**Step 3: Final lint and visual review**

```bash
cd ui && npm run lint
cd ui && npm run dev
```

Walk through all three views:
- Landing: compact, flat, history-focused
- Processing: plain stage list with hairline progress
- Analysis: stats bar + timeline + loudness + chat, all separated by hairlines only

**Step 4: Commit**

```bash
cd ui && git add -p
git commit -m "style: final pass — remove remaining decorative classes"
```
