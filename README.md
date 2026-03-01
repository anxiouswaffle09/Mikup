# Project Mikup (ꯃꯤꯀꯨꯞ)

**Definition:** *Mikup* (Meeteilon/Manipuri for "A split-second," "A blink," or "The exact moment.")

Project Mikup is a headless AI pipeline designed to "reverse engineer" the invisible architecture of high-end audio dramas. It deconstructs the mix, soundscaping, and pacing to generate objective, data-driven production documentation using an "Atomic Event" (Mikup) data model.

## Core Architecture

Treats audio as a sequence of **Mikups** (Atomic Events):
- **Pacing Mikup:** Gaps and silence between words.
- **Impact Mikup:** Sudden volume changes (ducking or swelling).
- **Spatial Mikup:** Psychoacoustic shifts in stereo width or reverb density.

### Headless Pipeline

1. **Ingestion & Surgical Separation:** Hybrid MBR→CDX23 pipeline — MBR vocal split (Pass 1) + CDX23/Demucs4 instrumental split (Pass 2) producing DX, Music, Effects stems.
2. **Transcription & Micro-Alignment:** WhisperX / Pyannote.audio (v4 Community-1) for word-level timestamps and diarization.
3. **Feature Extraction (DSP):** Librosa / Essentia for LUFS, onset detection, frequency analysis.
4. **Semantic Audio Understanding:** CLAP / Transformers v5 for semantic text tagging of audio stems.
5. **The "AI Director":** LLM (Gemini 2.0 Flash via Google-GenAI SDK) generates the actionable "Mikup Report."

## Getting Started

### Prerequisites

- Python 3.10+
- FFmpeg (required for audio processing)

### Installation

1. Clone the repository
2. Set up the virtual environment:
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   ```
3. Install dependencies for your platform:
   - **macOS (Apple Silicon):** `pip install -r requirements-mac.txt`
   - **Linux/Windows (NVIDIA GPU/CUDA):** `pip install -r requirements-cuda.txt`
4. (Optional, for full Stage 2 transcription) install `whisperx` in a compatible environment.
5. Copy `.env.example` to `.env` and add your API keys.

### Usage

Run the pipeline on a raw audio file:
```bash
python src/main.py --input "path/to/audio/file.wav"
```

## Directory Structure
- `src/ingestion`: Audio loading and stem separation (MBR + CDX23/Demucs4, 3-stem output)
- `src/dsp`: Digital Signal Processing (Librosa/Essentia feature extraction)
- `src/transcription`: WhisperX and Pyannote integration
- `src/semantics`: CLAP semantic audio tagging
- `src/llm`: The AI Director (Gemini/Claude integration)
- `data/`: Raw audio, processed stems, and output reports
