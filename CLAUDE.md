# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

Project Mikup (ꯃꯤꯀꯨꯞ) is a headless AI pipeline that reverse-engineers the audio production architecture of audio dramas. It treats audio as a sequence of **Atomic Events ("Mikups")**: pacing gaps, volume impact shifts, and spatial/reverb changes. The pipeline outputs a structured JSON payload consumed by an LLM ("AI Director") to generate production notes.

The project has two layers:
1. **Python backend** (`src/`): A 5-stage DSP + ML pipeline that processes raw audio into a `mikup_payload.json`.
2. **Tauri desktop UI** (`ui/`): A React/TypeScript frontend that visualizes the payload and hosts the AI Director chat interface; Rust bridges to the Python pipeline via subprocess invocation.

## Python Backend

### Setup
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
# FFmpeg must be installed separately (e.g. `brew install ffmpeg`)
# Copy .env.example to .env and fill in API keys
```

### Running the Pipeline
```bash
# Run on a real audio file (runs all 5 stages)
python src/main.py --input "path/to/audio.wav"

# Run in mock mode (no real audio/ML needed — uses pre-built test stems)
python src/main.py --input dummy --mock

# Run only the DSP stage against mock data
python src/dsp/processor.py

# Run only the semantic tagger against mock data
python src/semantics/tagger.py

# Generate fresh mock WAV stems + transcription JSON
python tests/mock_generator.py
```

### Environment Variables (`.env`)
| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Stage 5: AI Director via Gemini |
| `ANTHROPIC_API_KEY` | Stage 5: AI Director via Claude |
| `OPENAI_API_KEY` | Stage 5: AI Director via OpenAI |
| `HF_TOKEN` | Stage 2: Pyannote diarization (requires HuggingFace gated model access) |

## Tauri Desktop UI

The UI lives in `ui/`. All commands must be run from that directory.

```bash
cd ui
npm install

# Frontend dev server only (no Rust/Tauri)
npm run dev

# Lint
npm run lint

# Full Tauri desktop app (dev mode — requires Rust toolchain + Cargo)
cargo tauri dev

# Build distributable desktop app
cargo tauri build
```

The React dev server runs at `http://localhost:5173`. In dev mode, `App.tsx` loads the payload from `public/mikup_payload.json` (served statically by Vite). The real pipeline is triggered from the UI via the Tauri `process_audio` command defined in `ui/src-tauri/src/lib.rs`.

## Architecture & Data Flow

### Stage-by-Stage Pipeline (`src/main.py` orchestrates)

| Stage | File | Class | Key Libraries |
|---|---|---|---|
| 1: Stem Separation | `src/ingestion/separator.py` | `MikupSeparator` | `audio-separator` (MBR vocals) + `demucs` (CDX23 instrumental) |
| 2: Transcription + Diarization | `src/transcription/transcriber.py` | `MikupTranscriber` | `whisperx`, `pyannote.audio` |
| 3: DSP Feature Extraction | `src/dsp/processor.py` | `MikupDSPProcessor` | `librosa` |
| 4: Semantic Tagging | `src/semantics/tagger.py` | `MikupSemanticTagger` | CLAP (`laion/clap-htsat-fused`) via `transformers` |
| 5: AI Director | prompt: `src/llm/director_prompt.md` | — | Gemini / Claude / OpenAI (not yet wired in Python; currently stubbed in UI) |

### Stem Dictionary
`MikupSeparator.run_surgical_pipeline()` returns a dict using canonical 3-stem names:
```python
{
    "DX":         "stems/..._DX.wav",       # Pass 1: MBR vocal separator
    "Music":      "stems/..._Music.wav",    # Pass 2: CDX23 music stem
    "Effects":    "stems/..._Effects.wav",  # Pass 2: CDX23 effects stem
    "DX_Residual": "stems/..._DX_Residual.wav",  # Pass 2b optional: BS-Roformer refinement
}
```

### Final Payload Schema (`data/output/mikup_payload.json`)
```json
{
  "metadata": { "source_file": "...", "pipeline_version": "0.1.0-alpha" },
  "transcription": {
    "segments": [{ "start": 0.0, "end": 0.0, "text": "...", "speaker": "SPEAKER_01" }],
    "word_segments": [{ "word": "...", "start": 0.0, "end": 0.0 }]
  },
  "metrics": {
    "pacing_mikups": [{ "timestamp": 0.0, "duration_ms": 0, "context": "..." }],
    "spatial_metrics": { "total_duration": 0.0, "vocal_clarity": 0.0, "vocal_width": 0.0, "reverb_density": 0.0, "reverb_width": 0.0 },
    "impact_metrics": { "ducking_intensity": 0.0 }
  },
  "semantics": {
    "background_tags": [{ "label": "...", "score": 0.0 }]
  }
}
```

### Tauri Bridge
`ui/src-tauri/src/lib.rs` defines a single `process_audio` Tauri command. In dev mode it calls `.venv/bin/python3 src/main.py` as a subprocess (relative paths assume the working directory is the repo root). The `IngestionHeader` component calls `invoke('process_audio', ...)` and updates the React state with the returned JSON string.

### UI Components
- `App.tsx` — root layout, owns `payload` state
- `IngestionHeader.tsx` — triggers pipeline via Tauri invoke, shows status indicators
- `WaveformVisualizer.tsx` — renders transcript segments and pacing Mikups on a timeline
- `MetricsPanel.tsx` — displays spatial and impact metrics from the payload
- `DirectorChat.tsx` — AI Director chat UI (LLM API call is a TODO; currently stubs a response)

## Key Architecture Notes

- **VRAM management**: `flush_vram()` in `main.py` runs `gc.collect()` + `torch.cuda.empty_cache()` between stages to avoid OOM on GPU. Each stage's model is explicitly `del`-ed after use.
- **Mock mode**: Pass `--mock` to skip Stages 1 and 2 entirely and use pre-built WAVs from `data/processed/`. Use `python tests/mock_generator.py` to regenerate those files.
- **Stage 4 sampling**: CLAP only loads a 5-second window from the middle of the audio file (not the full file) to keep memory low.
- **Stage 5 (AI Director)** is not yet implemented in Python. The system prompt lives in `src/llm/director_prompt.md`. The UI's `DirectorChat.tsx` has a stub where the real API call should go.
- **Python path**: `src/main.py` uses package-style imports (`from src.ingestion.separator import ...`), so it must be run from the repo root, not from inside `src/`.
