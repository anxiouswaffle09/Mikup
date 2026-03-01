# DAW UI Overhaul Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement 4 UI pillars: StemControlStrip, High-Signal SVG Gauges, Ghost Waveforms, and AI Timestamp Seek.

**Architecture:** New StemControlStrip component wires to existing `set_stem_state` Tauri command. DiagnosticMeters gains SVG gauge sub-components replacing flat bars in LiveMeters. WaveformVisualizer gains 4 ghost wavesurfer instances (30px, opacity-40) synced to main DX master. AIBridge gains `[MM:SS]` timestamp interception + onSeek/onHighlight callbacks piped through App.tsx.

**Tech Stack:** React 19, TypeScript, wavesurfer.js 7, SVG, Tauri invoke, Tailwind CSS v4 (oklch)

---

### Task 1: StemControlStrip.tsx

**Files:**
- Create: `ui/src/components/StemControlStrip.tsx`

5 stem buttons (DX/Mint, Music/Lavender, SFX/Amber, Foley/Coral, Ambience/Slate). Each has Solo (S) + Mute (M) toggles. Solo activates glow border. Calls `invoke('set_stem_state', { stemId, isSolo, isMuted })`.

---

### Task 2: SVG Gauges in DiagnosticMeters.tsx

**Files:**
- Modify: `ui/src/components/DiagnosticMeters.tsx`

Add three SVG components integrated into `LiveMeters`:
1. `SemiCircleGauge` (SNR): 180° arc, red 0-5dB / yellow 5-15dB / green >15dB zones + animated needle
2. `StereoHeatbar` (Phase): horizontal bar -1→+1, cursor indicator, red background if value < 0
3. `CentroidNeedle` (Freq): log-scale 20Hz–20kHz bar with position indicator

---

### Task 3: Ghost Waveforms in WaveformVisualizer.tsx

**Files:**
- Modify: `ui/src/components/WaveformVisualizer.tsx`

Add `ghostStemPaths?: { musicPath?; sfxPath?; foleyPath?; ambiencePath? }` prop.
Create 4 ghost wavesurfer instances (30px height, muted, opacity-40) stacked below main DX.
Sync ghosts via main `audioprocess` + `interaction` events by calling `ghost.seekTo(time/duration)`.
Add `highlightAtSecs?: number | null` prop → renders a fade-out flare div at that position.

---

### Task 4: Timestamp Seek in AIBridge.tsx

**Files:**
- Modify: `ui/src/components/AIBridge.tsx`

Add `onSeek?: (secs: number) => void` and `onHighlight?: (secs: number) => void` props.
In message rendering, intercept `[MM:SS]` / `[HH:MM:SS]` patterns → render as `<button>` that calls `onSeek(secs)` + `onHighlight(secs)`.
Refactor `renderMarkdown` / `inlineFormat` to accept and thread through these callbacks.

---

### Task 5: Wire everything in App.tsx

**Files:**
- Modify: `ui/src/App.tsx`

1. Import and render `<StemControlStrip />` in analysis view header area
2. Add `highlightAtSecs` state, pass to `<WaveformVisualizer highlightAtSecs={...} />`
3. Pass `ghostStemPaths` resolved from `resolvePlaybackStemPaths()` to WaveformVisualizer
4. Pass `onSeek` + `onHighlight` to `<AIBridge />`
