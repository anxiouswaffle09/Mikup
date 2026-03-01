# TranscriptScrubber Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a `TranscriptScrubber` component that displays the transcription as readable text, highlights the active word in real-time as audio plays, auto-scrolls to keep the active segment visible, and lets the user click any word to seek the Rust audio engine.

**Architecture:** A single pure-presentational component that receives `currentTime` as a prop (derived from `dspStream.currentFrame.timestamp_secs`). For each `TranscriptionSegment`, the component filters `wordSegments` by time overlap to render individual clickable word spans. A `useEffect` watches the active segment index and calls `scrollIntoView` on the matching ref. The component is placed inside the right-hand `aside` in `App.tsx`, between the live meters block and the AIBridge.

**Tech Stack:** React 18 + TypeScript, Tailwind CSS (existing project conventions), `clsx` for conditional classes. No new dependencies.

---

### Task 1: Create `TranscriptScrubber.tsx`

**Files:**
- Create: `ui/src/components/TranscriptScrubber.tsx`

**Step 1: Write the component**

```tsx
import { useEffect, useMemo, useRef } from 'react';
import { clsx } from 'clsx';
import type { TranscriptionSegment, WordSegment } from '../types';

interface TranscriptScrubberProps {
  segments: TranscriptionSegment[];
  wordSegments: WordSegment[];
  currentTime: number;
  onSeek: (time: number) => void;
}

export function TranscriptScrubber({
  segments,
  wordSegments,
  currentTime,
  onSeek,
}: TranscriptScrubberProps) {
  const segmentRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Determine which segment is currently active
  const activeSegmentIdx = useMemo(
    () => segments.findIndex((seg) => currentTime >= seg.start && currentTime <= seg.end),
    [segments, currentTime],
  );

  // Pre-bucket word segments by segment index for O(1) lookup per render
  const wordsBySegment = useMemo(() => {
    const map = new Map<number, WordSegment[]>();
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      map.set(
        i,
        wordSegments.filter((w) => w.start >= seg.start && w.start < seg.end),
      );
    }
    return map;
  }, [segments, wordSegments]);

  // Auto-scroll active segment into view
  useEffect(() => {
    if (activeSegmentIdx < 0) return;
    segmentRefs.current[activeSegmentIdx]?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
  }, [activeSegmentIdx]);

  if (segments.length === 0) {
    return (
      <p className="text-[10px] font-mono text-text-muted uppercase tracking-widest">
        No transcription data
      </p>
    );
  }

  return (
    <div className="overflow-y-auto max-h-full pr-1 space-y-5 scrollbar-thin">
      {segments.map((seg, segIdx) => {
        const words = wordsBySegment.get(segIdx) ?? [];
        const isActiveSegment = segIdx === activeSegmentIdx;

        return (
          <div
            key={`${seg.start}-${segIdx}`}
            ref={(el) => { segmentRefs.current[segIdx] = el; }}
            className={clsx(
              'transition-opacity duration-300',
              activeSegmentIdx >= 0 && !isActiveSegment && 'opacity-40',
            )}
          >
            {/* Speaker label */}
            {seg.speaker && (
              <p className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-1.5 font-mono">
                {seg.speaker}
              </p>
            )}

            {/* Word-level rendering when word segments are available */}
            {words.length > 0 ? (
              <p className="font-serif text-sm leading-relaxed text-text-main">
                {words.map((word, wIdx) => {
                  const isActiveWord =
                    currentTime >= word.start && currentTime <= word.end;
                  return (
                    <span key={`${word.start}-${wIdx}`}>
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={() => onSeek(word.start)}
                        onKeyDown={(e) => e.key === 'Enter' && onSeek(word.start)}
                        className={clsx(
                          'cursor-pointer rounded-sm px-0.5 transition-colors duration-75',
                          isActiveWord
                            ? 'bg-accent/20 text-accent'
                            : 'hover:bg-accent/10 hover:text-accent',
                        )}
                      >
                        {word.word}
                      </span>
                      {' '}
                    </span>
                  );
                })}
              </p>
            ) : (
              /* Fallback: segment-level click when no word segments exist */
              <p
                role="button"
                tabIndex={0}
                onClick={() => onSeek(seg.start)}
                onKeyDown={(e) => e.key === 'Enter' && onSeek(seg.start)}
                className={clsx(
                  'font-serif text-sm leading-relaxed text-text-main cursor-pointer rounded-sm px-0.5',
                  'hover:bg-accent/10 hover:text-accent transition-colors',
                  isActiveSegment && 'text-accent',
                )}
              >
                {seg.text}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

**Step 2: Verify linting passes (no new deps required)**

Run from `ui/` directory:
```bash
npm run lint
```
Expected: no errors related to `TranscriptScrubber.tsx`.

**Step 3: Commit**

```bash
git add ui/src/components/TranscriptScrubber.tsx
git commit -m "feat(ui): add TranscriptScrubber component with word-level highlighting and click-to-seek"
```

---

### Task 2: Integrate TranscriptScrubber into `App.tsx`

**Files:**
- Modify: `ui/src/App.tsx`

**Step 1: Add the import**

In `App.tsx`, add after the existing component imports (around line 11):

```tsx
import { TranscriptScrubber } from './components/TranscriptScrubber';
```

**Step 2: Add the component in the analysis view `aside`**

The `aside` currently has two children:
1. Live meters block (`dspStream.currentFrame && ...`)
2. AI Bridge block

Insert the TranscriptScrubber between them. The aside needs a constrained height to make the scrubber scrollable without overflowing the viewport. Replace:

```tsx
<aside className="lg:col-span-4 flex flex-col px-6 py-5 gap-6">
```

with:

```tsx
<aside className="lg:col-span-4 flex flex-col px-6 py-5 gap-6 min-h-0">
```

Then insert the TranscriptScrubber section between the live meters block and the AI Bridge block:

```tsx
{/* Transcript Scrubber */}
{payload?.transcription && (payload.transcription.segments.length > 0) && (
  <div className="flex flex-col min-h-0" style={{ maxHeight: '340px' }}>
    <div className="flex items-center justify-between mb-3">
      <span className="text-[10px] uppercase tracking-widest font-bold text-text-muted">
        Transcript
      </span>
      {dspStream.currentFrame && (
        <span className="text-[10px] font-mono text-text-muted tabular-nums">
          {dspStream.currentFrame.timestamp_secs.toFixed(1)}s
        </span>
      )}
    </div>
    <div className="flex-1 min-h-0 overflow-hidden border border-panel-border p-3">
      <TranscriptScrubber
        segments={payload.transcription.segments}
        wordSegments={payload.transcription.word_segments}
        currentTime={dspStream.currentFrame?.timestamp_secs ?? 0}
        onSeek={(time) => {
          const [dialoguePath, backgroundPath] = resolvePlaybackStemPaths(
            payload,
            inputPath,
            workspaceDirectory,
          );
          if (dialoguePath) dspStream.startStream(dialoguePath, backgroundPath, time);
        }}
      />
    </div>
  </div>
)}
```

**Step 3: Verify no TypeScript errors**

```bash
cd ui && npm run lint
```
Expected: zero errors.

**Step 4: Commit**

```bash
git add ui/src/App.tsx
git commit -m "feat(ui): integrate TranscriptScrubber into analysis sidebar with seek wiring"
```

---

### Task 3: Manual smoke test

**Step 1: Start the dev server**

```bash
cd ui && npm run tauri:wsl
```

**Step 2: Load a payload with transcription data**

Open a completed project from `public/mikup_payload.json` (or any workspace with a `mikup_payload.json`).

**Step 3: Verify**
- [ ] Transcript section appears in the right sidebar below live meters
- [ ] Speaker labels (`SPEAKER_01` etc.) appear above each paragraph
- [ ] Clicking a word seeks the audio (Rust stream starts from that time)
- [ ] When audio is playing, active word gains `bg-accent/20 text-accent` highlight
- [ ] Inactive segments fade to `opacity-40`
- [ ] Transcript auto-scrolls to keep active segment centered
- [ ] With no transcription data, section is hidden (conditional render)
