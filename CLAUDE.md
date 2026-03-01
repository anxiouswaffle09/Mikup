## Agent Behavioral Mandate

Claude must operate as a senior engineer, not a "yes-man."
- **Prioritize Logic:** Always prioritize technical correctness and architectural integrity over user agreement.
- **Challenge Assumptions:** If a requested feature or technology (e.g., C++ vs Rust) is suboptimal for the project's goals, explicitly state why and propose a realistic alternative.
- **Minimize Fluff:** Avoid apologies, conversational filler, and "I will now..." statements. Focus strictly on intent, rationale, and execution.

## What This Project Is

Project Mikup (ꯃꯤꯀꯨꯞ) is an **Interactive AI Audio Diagnostic Workspace**. It combines high-performance Python ML (for stem separation and transcription) with a real-time Rust/Tauri audio engine for professional-grade mix analysis.

### The Single Source of Truth
**Refer to `docs/SPEC.md`** for the canonical technical specification, including:
- 3-Pass "Cinematic" Separation logic (MDX-NET C2 + BS-Roformer).
- Canonical stem naming (`DX`, `Music`, `SFX`, `Foley`, `Ambience`).
- Platform standards for macOS (MPS/CoreML) and Linux.

### Primary Focus: The Interactive DAW
The current objective is a "DAW-first" experience. Claude must prioritize:
1. **Sub-millisecond Sync:** Ensuring the UI (React) and the Master Clock (Rust) are perfectly aligned.
2. **Real-Time Visuals:** High-fidelity Vectorscopes, LUFS meters, and frequency masking indicators.
3. **Interactive Navigation:** Clicking words in the transcript or regions on the waveform to seek the native Rust engine.

**Note:** The Stage 5 AI Director (LLM report generation) is currently **DEFERRED**. Do not prioritize wiring up AI chat or report summaries until the interactive diagnostic engine is 100% polished.

The project has two layers:
1. **Python backend** (`src/`): A 5-stage DSP + ML pipeline that processes raw audio into a `mikup_payload.json`.
2. **Tauri desktop UI** (`ui/`): A React/TypeScript frontend that visualizes the payload and hosts the AI Director chat interface; Rust bridges to the Python pipeline via subprocess invocation.

## Python Backend

### Setup
```bash
python3 -m venv .venv
source .venv/bin/activate

# Choose the requirements file for your platform:
# macOS (Apple Silicon):
pip install -r requirements-mac.txt

# Linux/Windows (NVIDIA GPU/CUDA):
pip install -r requirements-cuda.txt

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
npm run tauri dev

# WSL2-specific Tauri dev (forces software rendering to fix display issues)
npm run tauri:wsl

# Build distributable desktop app
npm run tauri build
```

The React dev server runs at `http://localhost:5173`. In dev mode, `App.tsx` loads the payload from `public/mikup_payload.json` (served statically by Vite). The real pipeline is triggered from the UI via the Tauri `process_audio` command defined in `ui/src-tauri/src/lib.rs`.

## Architecture & Data Flow

### Stage-by-Stage Pipeline (`src/main.py` orchestrates)

| Stage | File | Class | Key Libraries |
|---|---|---|---|
| 1: Stem Separation | `src/ingestion/separator.py` | `MikupSeparator` | `audio-separator` (MDX-NET C2 + BS-Roformer) |
| 2: Transcription + Diarization | `src/transcription/transcriber.py` | `MikupTranscriber` | `whisper`, `pyannote.audio` |
| 3: DSP Feature Extraction | `src/dsp/processor.py` | `MikupDSPProcessor` | `librosa` |
| 4: Semantic Tagging | `src/semantics/tagger.py` | `MikupSemanticTagger` | CLAP (`laion/clap-htsat-fused`) via `transformers` |
| 5: AI Director | prompt: `src/llm/director_prompt.md` | — | Gemini 2.0 Flash |

### Stem Dictionary
Refer to `docs/SPEC.md` for the 3-pass separation logic. `MikupSeparator.run_surgical_pipeline()` returns a dict using canonical names:
```python
{
    "dx":         "stems/..._DX.wav",       # Dialogue (Dry)
    "music":      "stems/..._Music.wav",    # Score
    "sfx":        "stems/..._SFX.wav",      # Hard FX
    "foley":      "stems/..._Foley.wav",    # Movement
    "ambience":   "stems/..._Ambience.wav", # Background
}
```

### Final Payload Schema (`data/output/mikup_payload.json`)
```json
{
  "metadata": { "source_file": "...", "pipeline_version": "0.2.0-beta" },
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
- `DirectorChat.tsx` — AI Director chat UI (interactive tool-calling enabled)

## Key Architecture Notes

- **VRAM management**: `flush_vram()` in `main.py` runs `gc.collect()` + `torch.cuda.empty_cache()` between stages to avoid OOM on GPU. Each stage's model is explicitly `del`-ed after use.
- **Mock mode**: Pass `--mock` to skip Stages 1 and 2 entirely and use pre-built WAVs from `data/processed/`. Use `python tests/mock_generator.py` to regenerate those files.
- **Stage 4 sampling**: CLAP only loads a 5-second window from the middle of the audio file (not the full file) to keep memory low.
- **Stage 5 (AI Director)** is interactive. The system prompt lives in `src/llm/director_prompt.md`.
- **Python path**: `src/main.py` uses package-style imports (`from src.ingestion.separator import ...`), so it must be run from the repo root, not from inside `src/`.
