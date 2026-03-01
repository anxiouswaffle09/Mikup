# Design: MikupConsole, Canonical Stems & DSP Persistence

**Date:** 2026-02-28
**Status:** Approved (autonomous — no user gate)

---

## 1. MikupConsole Component

**File:** `ui/src/components/MikupConsole.tsx`

A self-contained terminal log component that registers its own `process-status` Tauri listener. Each event appends a formatted line to an internal log array. The container scrolls to bottom on each new line.

### Stage-to-color mapping
| Stage prefix | Color class | Emoji |
|---|---|---|
| `SEPARATION`, `CINEMA` | `text-fuchsia-400` | 📽️ |
| `VOX`, `DX`, `DIALOGUE` | `text-cyan-400` | 💎 |
| `DSP` | `text-blue-400` | 📊 |
| `FX`, `SFX` | `text-amber-400` | ⚡ |
| `TRANSCRIPTION` | `text-green-400` | 📝 |
| `AMBIENCE` | `text-violet-400` | 🌊 |
| `FOLEY` | `text-yellow-300` | 👣 |
| Default | `text-zinc-400` | — |

Each log line renders as:
```
[STAGE] <emoji> message                   NN%
```
Background: `bg-[#0a0a0a]`. Font: `font-mono text-[11px]`. Autoscroll via `useEffect` + `scrollIntoView`.

### Integration
- Replace the static stage checklist block in `App.tsx`'s `processing` view with `<MikupConsole />`.
- Stage list dot indicators remain above the console (keep pipeline state visible).

---

## 2. Canonical Stem Naming

### `types.ts` — `deriveStemPathsFromSource`
Remove legacy `_Vocals.wav`, `_Background.wav`, `_Reverb.wav`, `_Dry_Vocals.wav`. Return only:
```
_DX.wav, _Music.wav, _Foley.wav, _SFX.wav, _Ambience.wav
```

### `types.ts` — `resolveStemAudioSources`
After collecting paths, sort so `_DX.wav` always appears first (primary waveform for WaveformVisualizer).

### `App.tsx` — cleanup
- Delete `deriveStemPaths` function (lines 55–62).
- Update `resolvePlaybackStemPaths` to search for `/_DX\./i` (dialogue) and `/_Music\./i` (background) patterns instead of `/vocals|dialogue/i` and `/instrumental|background/i`.
- For the live DSP stream path resolution, if neither canonical match is found, fall back to `stems[0]` / `stems[1]` for resilience.

---

## 3. DSP Metrics Persistence ("Persistence Gap" fix)

### Rust — new `write_dsp_metrics` command (`lib.rs`)
Writes `{workspace}/data/dsp_metrics.json`:
```json
{
  "dialogue_integrated_lufs": -18.4,
  "dialogue_loudness_range_lu": 6.2,
  "background_integrated_lufs": -24.1,
  "background_loudness_range_lu": 4.8
}
```
Registered in `invoke_handler!`. Non-fatal on error (same pattern as `mark_dsp_complete`).

### `App.tsx` — call after `completePayload`
In the `useEffect` watching `dspStream.completePayload`, after the existing `mark_dsp_complete` call, invoke `write_dsp_metrics` with the four LUFS values.

---

## 4. UI Polish

### Invalid Date fix (`App.tsx`)
Current: `new Date(payload?.metadata?.timestamp || '').toLocaleDateString()` → `Invalid Date`.
Fix: guard with existence check before constructing `Date`:
```tsx
{payload?.metadata?.timestamp
  ? new Date(payload.metadata.timestamp).toLocaleDateString()
  : '—'}
```

### WaveformVisualizer — DX as primary
No component changes needed. Sorting in `resolveStemAudioSources` ensures DX is `audioSources[0]`. WaveformVisualizer already tries sources in order.

### MetricsPanel — canonical label update
Change stream toggle label from `"Dialogue"` → `"DX"` and `"Background"` → `"Music"` to match canonical stem naming. Tooltip rows similarly updated.

---

## Files Touched

| File | Change |
|---|---|
| `ui/src/components/MikupConsole.tsx` | **CREATE** |
| `ui/src/App.tsx` | Replace checklist with MikupConsole; fix date; remove `deriveStemPaths`; update `resolvePlaybackStemPaths`; add `write_dsp_metrics` invocation |
| `ui/src/types.ts` | Update `deriveStemPathsFromSource`; sort DX-first in `resolveStemAudioSources` |
| `ui/src-tauri/src/lib.rs` | Add `write_dsp_metrics` command + register it |
| `ui/src/components/MetricsPanel.tsx` | Update stream toggle / tooltip labels to DX / Music |
