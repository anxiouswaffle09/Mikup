# Project Mikup (ꯃꯤꯀꯨꯞ)

**Definition:** *Mikup* (Meeteilon/Manipuri for "A split-second," "A blink," or "The exact moment.")
**Goal:** A headless AI pipeline designed to "reverse engineer" the invisible architecture of high-end audio dramas. It deconstructs the mix, soundscaping, and pacing to generate objective, data-driven production documentation.

## 1. Core Philosophy: The "Atomic Event" Data Model
Instead of analyzing audio by "scene" or "episode," the system treats audio as a sequence of **Mikups** (Atomic Events).
- **A "Pacing Mikup":** A deliberate gap/silence between words.
- **An "Impact Mikup":** A sudden volume change (ducking or swelling) in the music or SFX stems.
- **A "Spatial Mikup":** A psychoacoustic shift in the stereo width or reverb density.

## 2. The Tech Stack & Pipeline (Headless Architecture)
The engine relies on a Python-based pipeline that turns raw audio into structured JSON data, which is then interpreted by an LLM (Claude/Gemini/Codex) to generate human-readable production notes.

### Stage 1: Ingestion & Surgical Separation
- **Tool:** Ultimate Vocal Remover (UVR5) framework.
- **Process:** A multi-pass extraction pipeline.
  1. *Cinematic Split:* (htdemucs_ft) Splits master into Dialogue, Music, and SFX.
  2. *De-Reverb Pass:* (VR Architecture) Separates Dry Voice from the Reverb Tail.
  3. *Dialogue Enhance:* Separates Foreground Lead Voice from Background Walla (crowd noise).

### Stage 2: Transcription & Micro-Alignment
- **Tool:** WhisperX / Pyannote.audio.
- **Process:** Word-level timestamping, speaker diarization, and handling overlapping dialogue for precise pacing metrics.

### Stage 3: Feature Extraction (DSP)
- **Tools:** Librosa / Essentia (Python).
- **Process:** Calculates LUFS (Loudness Units) over time for ducking analysis, onset detection for SFX transients, and frequency spectrum analysis.

### Stage 4: Semantic Audio Understanding
- **Tool:** CLAP (Contrastive Language-Audio Pretraining).
- **Process:** Analyzes chopped stems (e.g., Ambience or SFX) to assign semantic text tags (e.g., "Forest, Wind, Leaves" vs. "Tavern, Crowd, Glass Clinking").

### Stage 5: The "AI Director" (Reasoning & Scoring)
- **Tools:** Gemini 1.5 Pro / Claude 3.5 Sonnet.
- **Process:** The LLM receives the heavily structured JSON payload (timestamps, volume curves, semantic tags) and outputs a "Mikup Report" (Production Notes & Recipes) for the engineering team.

## 3. The "Hidden Metrics" (What We Are Measuring)

### The Invisible Mix
- **Spatial Breathing (Stereo Width Variance):** Tracking phase correlation to measure psychoacoustic space (e.g., claustrophobic mono vs. expansive wide stereo).
- **Reverb Indexing (The Geometry of the Scene):** Measuring decay times (RT60) to map physical journeys (tight hallway vs. cathedral) and internal monologues (zero reverb).
- **Volume Ducking & The Drop-Out:** Measuring how Music/Ambience swells around dialogue, or drops to total silence (-inf dB) precisely before a revelation (The Reverse Jump Scare).

### Sonic Semantics (The "Vibe" Check)
- **Foley vs. Hard FX Split:** Using DSP to filter midrange organic movement (Foley) from sub-bass synthetic impacts (Hard FX), scoring how intimacy vs. dynamic impact is balanced.
- **Transient Aggression:** Measuring the sharpness of non-dialogue stems (snappy footsteps for comedy vs. muffled thuds for thrillers).

### The Rhythm of Direction (The Heartbeat)
- **Micro-Pacing (Inter-line gaps):** Measuring milliseconds of silence between speaker segments to map the "BPM of conversation."
- **Macro-Pacing (Scene Density):** Plotting words-per-minute over an episode to ensure dynamic peaks and valleys in the narrative flow.

## 4. Edge Cases Handled by the Architecture
1. **Diegetic vs. Non-Diegetic Music:** Differentiated by frequency profiling (band-passed/worldized vs. full-spectrum wide).
2. **Inner Monologue vs. Spoken Dialogue:** Differentiated by the wet/dry reverb ratio.
3. **Non-Verbal Acting (Crying, Gasping):** Handled via a VAD (Voice Activity Detector) vs. ASR (Whisper) cross-check, routed to CLAP for semantic tagging.
4. **Subjective POV Shifts (Acoustic Trauma):** Detected via rapid, synchronized EQ sweeps (low-pass filtering) across all stems simultaneously.
5. **Walla vs. Ambience:** Handled by running Dialogue Enhance models prior to Noise Removal models, preventing background human voices from destroying the primary vocal track or polluting the Ambience stem.

## 5. Deliverable: The Mikup Report
The final output is an objective, actionable document for production teams containing "Recipes."
*Example:* "At Mikup 15:30, a 2.1-second dialogue gap was used while the Sub-bass Ambience swelled by 4dB, establishing immense pressure before the final line."

## 6. Future Roadmap: The Mikup Desktop App (Tauri-based)
To transition from a headless pipeline to a production-ready tool, Project Mikup will evolve into a **Local-First Desktop Application** using the **Tauri** framework.

### Hybrid Architecture Strategy
- **Frontend:** React/TypeScript (Tauri) for a high-performance, low-memory UI.
- **Local Engine (The Sidecar):** The Python DSP pipeline (UVR5, WhisperX, CLAP) will be bundled as a "Sidecar" executable. Heavy audio processing remains local to avoid cloud GPU costs and preserve user privacy.
- **Intelligence Layer:** A "Hybrid Cloud" approach for Stage 5 (The AI Director).

### Dual-Path AI Routing (User Choice)
The app will offer two ways to generate the final Mikup Report:
1.  **Mikup Pro (Subscription):** Users log in via a central account (managed via Supabase/Stripe). The app sends the local JSON metadata to a secure proxy that runs the LLM analysis using the project's master API keys.
2.  **Custom Key (BYOK - Bring Your Own Key):** Power users can provide their own Gemini or Claude API keys. In this mode, the app communicates directly with the AI provider from the user's machine, bypassing Mikup’s servers entirely.

### Key Desktop Features
- **Visual Waveform Sync:** Using Wavesurfer.js to overlay "Impact" and "Pacing" Mikups directly onto the audio timeline.
- **Secure Key Storage:** Utilizing the system keychain (macOS Keychain / Windows Credential Manager) for API keys and Auth tokens.
- **Batch Processing:** Local queuing of multiple audio files for overnight analysis.
