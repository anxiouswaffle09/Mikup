# Mikup Technical Specification (Source of Truth)

**Version:** 0.3.0-beta
**Focus:** Hybrid Surgical Separation (MBR + CDX23)
**Platforms:** macOS (Silicon/Intel), Linux (WSL2/Native)

## 1. Surgical Separation Pipeline (Stage 1)
All separation follows this hybrid 2-pass architecture.

### Pass 1: MBR Vocal Extraction
- **Model:** `vocals_mel_band_roformer.ckpt` (SDR 12.6) via audio-separator
- **Stems:** `vocals` → DX candidate, `other` → instrumental
- **Rationale:** Specialist vocal model outperforms CDX23's single-pass 3-way split for dialog clarity.

### Pass 2: CDX23 Instrumental Split
- **Model:** CDX23 (Demucs4/DnR) via demucs API
- **Input:** `other` (instrumental) from Pass 1
- **Stems:** `Music`, `Effects` (CDX23's own dialog output is discarded)
- **Models dir:** `~/.cache/mikup/cdx23/` (auto-downloaded on first run)
- **Rationale:** With dialog already removed, CDX23 cleanly splits music vs. effects.

### Pass 2b: DX Refinement (optional)
- **Model:** `BS-Roformer-Viperx-1297` (`model_bs_roformer_ep_317_sdr_12.9755.ckpt`)
- **Action:** Process the Pass 1 vocals stem.
- **Outputs:** `DX` (clean dialogue), `DX_Residual` (residual bleed).
- **Toggle:** Skipped when `fast_mode=True`.

## 2. Canonical Stem Naming
The project officially deprecates the 5-stem "Cinematic Trinity" split in favor of a high-fidelity 3-stem hybrid:
- `DX`: Primary dry dialogue.
- `Music`: Full orchestral/electronic score.
- `Effects`: All non-music, non-dialog audio (hard FX, ambience, foley combined).
- `DX_Residual`: Optional residual from Pass 2b; omitted in fast mode.

## 3. Platform Standards
### macOS (Darwin)
- **Dependencies:** `pip install -r requirements-mac.txt`
- **Torch:** Use `mps` device.
- **ONNX:** Use `CoreMLExecutionProvider`.
- **FFmpeg:** Must be available via `brew`.

### Linux/WSL2
- **Dependencies:** `pip install -r requirements-cuda.txt`
- **Torch:** Use `cuda` (if available) or `cpu`.
- **ONNX:** Use `CUDAExecutionProvider`.
- **Tauri:** Use `tauri:wsl` to bypass hardware acceleration bugs.

## 4. UI/UX Standards
- **Mikup Console:** A real-time, autoscrolling terminal log in the "Processing" view.
- **Visuals:** Minimalist Light / Pastel (`oklch()`).
- **Telemetry:** 60fps live metering (LUFS, Phase, Vectorscope) via Rust/Tauri bridge.
