# Mikup Technical Specification (Source of Truth)

**Version:** 0.2.0-beta
**Focus:** Surgical Cinematic Deconstruction
**Platforms:** macOS (Silicon/Intel), Linux (WSL2/Native)

## 1. Surgical Separation Pipeline (Stage 1)
Hybrid 2-pass architecture: MBR vocal isolation followed by CDX23 instrumental split.

### Pass 1: MBR Vocal Separation
- **Model:** `vocals_mel_band_roformer.ckpt` (MBR — Mel Band Roformer)
- **Action:** Split input into `DX` (vocals) and `instrumental` (everything else).
- **Rationale:** MBR achieves best-in-class vocal SDR, providing a clean DX stem for transcription.

### Pass 2: CDX23 Instrumental Split
- **Models:** CDX23 ensemble (`97d170e1-a778de4a.th`, `97d170e1-dbb4db15.th`, `97d170e1-e41a5468.th`)
  — Fast mode uses only the second model.
- **Action:** Split the Pass 1 instrumental into `Music` and `Effects`.
- **Rationale:** CDX23 was purpose-built for cinematic sound demixing (music vs. hard FX).

### Pass 2b: DX Refinement (Optional)
- **Model:** `BS-Roformer-Viperx-1297` (or equivalent BS-Roformer variant)
- **Action:** Refine the Pass 1 `DX` stem to produce `DX_Residual` (reverb/noise).
- **Rationale:** Optional post-processing for additional dialogue clarity; skipped in fast mode.

## 2. Canonical Stem Naming
The project uses exactly 3 primary stems + 1 optional:
- `DX`: Primary dialogue/vocal stem (dry, from MBR Pass 1).
- `Music`: Score / orchestral / electronic bed (from CDX23 Pass 2).
- `Effects`: Hard FX, ambience, foley — all non-musical background (from CDX23 Pass 2).
- `DX_Residual` *(optional)*: Reverb/noise extracted from DX during Pass 2b.

## 3. Platform Standards
### macOS (Darwin)
- **Dependencies:** `pip install -r requirements-mac.txt` (uses standard `onnxruntime`).
- **Torch:** Use `mps` device.
- **ONNX:** Use `CoreMLExecutionProvider`.
- **FFmpeg:** Must be available via `brew`.

### Linux/WSL2
- **Dependencies:** `pip install -r requirements-cuda.txt` (uses `onnxruntime-gpu`).
- **Torch:** Use `cuda` (if available) or `cpu`.
- **ONNX:** Use `CUDAExecutionProvider`.
- **Tauri:** Use `tauri:wsl` to bypass hardware acceleration bugs.

## 4. UI/UX Standards
- **Mikup Console:** A real-time, autoscrolling terminal log in the "Processing" view.
- **Visuals:** Minimalist Light / Pastel (`oklch()`).
- **Telemetry:** 60fps live metering (LUFS, Phase, Vectorscope) via Rust/Tauri bridge.
