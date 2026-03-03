# GPUI High-Density Timeline PoC — Design

## Goal
Prove a native Rust UI (GPUI) can sustain <16.6ms frame times under 60Hz telemetry updates with a scrollable waveform and 5,000-word virtualized transcript.

## Architecture: Multi-Entity Split

Three isolated state buckets minimize render invalidation:

| Entity | Tick Rate | Triggers Repaint Of |
|--------|-----------|---------------------|
| `DspState` | 60Hz timer | Playhead overlay, active word |
| `TimelineState` | User input | Waveform canvas |
| `TranscriptState` | ~2-3Hz (word boundary crossings) | Transcript list |

## Components

- **WaveformView** — `gpui::canvas`, paints precomputed min/max peaks + playhead line
- **TranscriptView** — `uniform_list` (5,000 items), highlights active word, click-to-seek
- **StatusBar** — frame time, playhead position, play/pause state

## Data Simulation

- Audio: 10min × 44.1kHz sine sweep, precomputed to ~51,680 min/max peak blocks
- Transcript: 5,000 words with sequential timestamps spanning 600 seconds

## Interactions

- Scroll wheel → pan waveform
- Ctrl+scroll → zoom waveform
- Click word → seek playhead
- Space → toggle play/pause

## File Structure

```
poc/gpui_timeline/
├── Cargo.toml
└── src/
    ├── main.rs
    ├── state.rs
    ├── waveform_view.rs
    ├── transcript_view.rs
    ├── root_view.rs
    └── data.rs
```

## Success Criteria

- Frame time < 16.6ms during scroll + active playhead
- No GC jank (Rust = no GC)
- Lower CPU/memory than equivalent Tauri WebView
