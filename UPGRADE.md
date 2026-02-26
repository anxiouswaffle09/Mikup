# Upgrade Log: February 2026

## Overview
This document tracks the major infrastructure and dependency upgrades performed to keep Mikup at the cutting edge of AI and audio processing.

## 🚀 Key Upgrades

### 1. AI Director (LLM Stack)
- **Migrated from `google-generativeai` to `google-genai` (v1.0.0)**.
- **Model Shift:** Updated default model to `gemini-2.0-flash`.
- **Reasoning:** Improved response times and better handling of multimodal data.

### 2. Audio Processing Pipeline
- **pyannote.audio (v4.0.4):** 2.2x speedup in diarization using the new `community-1` model architecture.
- **audio-separator (v0.41.1):** Native support for Roformer models, significantly improving vocal/music separation quality.
- **Transformers (v5.2.0):** Native support for "Multimodal Auto" classes for future-proofing semantic audio understanding.

### 3. Frontend Architecture
- **Tailwind CSS v4:** Migrated from v3. Completely removed `tailwind.config.js` in favor of `@theme` variables in `index.css`.
- **React 19:** Full stable support with the React Compiler.
- **Vite 7:** Improved HMR and bundle efficiency.

## 🛠 Manual Steps for Developers
If you are pulling these changes:
1.  **Backend:** `pip install -r requirements.txt`
2.  **Frontend:** `cd ui && npm install`
3.  **Tauri:** `npm run tauri dev`
