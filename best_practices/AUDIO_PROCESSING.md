# Best Practices: Audio Processing & Separation

Updated as of: March 2, 2026

## Native Audio Engine (Rust/Tauri)
For the interactive DAW, low-latency playback and high-frequency metering are mandatory.

### Key Practices:
- **Engine Choice:** Use `cpal` (for raw device access) and `rodio` (for playback management) in the Rust backend. Avoid browser-based `<audio>` tags for diagnostic playback due to jitter and lack of sample-accurate control.
- **Sync Protocol:** The playhead position must be owned by the Rust backend and "pushed" to the UI via Tauri Events. UI-side "pulling" is prohibited for high-accuracy scrubbing.
- **Memory Management:** Use shared buffers (`Arc<Vec<f32>>`) between the playback thread and the diagnostic analysis thread (Vectorscope/Loudness) to avoid redundant copies.

## Loudness & Dynamics (BS.1770-4)
- **Target LUFS:** Aim for -23 LUFS integrated for standard dialogue stems.
- **True Peak:** Maintain a maximum true peak of -1.0 dBTP.
- **Engine:** Use the native Rust `mikup-dsp` module for all loudness calculations. Python-side normalization is deprecated.

## audio-separator (v0.41.1)
- **Roformer for Dialogue:** Use `model_bs_roformer_ep_317_sdr_12.9755.ckpt`.
- **Hybrid Strategy:** See `ML_INFRASTRUCTURE.md` for the Hybrid 2-Pass strategy (Roformer + CDX23).
- **Denoising:** Enable `mdx_enable_denoise` strictly for the transcription pass, but keep the raw stem for the DAW's "Diagnostic" view.

## WhisperX (v3.8) Alignment
- **Phoneme Accuracy:** Always match the alignment model to the target language (e.g., `WAV2VEC2_ASR_LARGE_LV60K_960H`).
- **Transcript Drift:** Implement a 10ms "safety buffer" at the start/end of every transcript segment to avoid cutting off fast plosives during scrubbing.
