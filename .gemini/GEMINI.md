# Project Mikup (ꯃꯤꯀꯨꯞ)

## Overview
**Project Mikup** is a headless AI pipeline designed to "reverse engineer" the invisible architecture of high-end audio dramas. It deconstructs the mix, soundscaping, and pacing to generate objective, data-driven production documentation using an "Atomic Event" (Mikup) data model.

## Core Philosophy
Treats audio as a sequence of **Mikups** (Atomic Events):
- **Pacing Mikup:** Gaps and silence between words.
- **Impact Mikup:** Sudden volume changes (ducking or swelling).
- **Spatial Mikup:** Psychoacoustic shifts in stereo width or reverb density.

## Headless Pipeline Architecture (Python-based)
1.  **Ingestion & Surgical Separation:** UVR5 framework (htdemucs_ft, VR Architecture) for dialogue/music/SFX and wet/dry vocal splitting.
2.  **Transcription & Micro-Alignment:** WhisperX / Pyannote.audio for word-level timestamps and speaker diarization.
3.  **Feature Extraction (DSP):** Librosa / Essentia for LUFS (volume ducking), onset detection, and frequency analysis.
4.  **Semantic Audio Understanding:** CLAP for semantic text tagging of audio stems (e.g., Ambience or SFX).
5.  **The "AI Director":** LLM (Claude 3.5 Sonnet / Gemini 1.5 Pro) processes the structured JSON payload to output the actionable "Mikup Report".

## Core Metrics ("What We Measure")
- **Spatial Breathing:** Stereo width variance and phase correlation.
- **Reverb Indexing:** Decay times (RT60) mapping physical and psychological space (wet/dry ratio).
- **Volume Ducking:** Music/Ambience dynamics around dialogue.
- **Foley vs. Hard FX Split:** Filtering organic movement vs. synthetic impact.
- **Micro/Macro Pacing:** Inter-line gaps (milliseconds) and scene density (WPM).

## Key Files
- `idea.md`: The core foundational document outlining the project's complete philosophy, edge cases, metrics, and architecture.

## Usage
Currently in architectural planning and early development. This repository will host the Python-based DSP pipeline, audio ingestion scripts, semantic tagging modules, and LLM integrations described in the documentation.