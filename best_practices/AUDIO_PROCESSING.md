# Best Practices: Audio Processing & Separation

Updated as of: February 26, 2026

## pyannote.audio (v4.0.4 "Community-1")
A major architectural shift for speaker diarization and segmentation.

### Key Practices:
- **Model Migration:** Upgrade from `segmentation-3.0` to `speaker-diarization-community-1`. It is 2x faster on H100/A100 hardware.
- **Local Config:** Use the new YAML structure for offline-first processing (essential for the Mikup headless pipeline).
- **Threshold Optimization:** Use `pipeline.tune_iter` on a small subset of the project's data to find the optimal DER (Diarization Error Rate) for high-reverb audio dramas.

### Snippet (Local Load):
```python
from pyannote.audio import Pipeline
pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-community-1", token=True)
# For audio dramas, use lower min_duration_off to capture fast-paced dialogue
pipeline.freeze({"segmentation": {"min_duration_off": 0.0}})
```

## audio-separator (v0.41.1)
Now supports Roformer models which are superior for vocal/SFX/Music separation in complex mixes.

### Key Practices:
- **Roformer over MDX:** Use `model_bs_roformer_ep_317_sdr_12.9755.ckpt` for the primary dialogue stem extraction.
- **Batch Processing:** Use the `separate_audio_and_wait` API for batching multiple scenes.
- **Denoising:** Enable `mdx_enable_denoise` for raw ingestion before transcription to improve WhisperX accuracy.

### Metrics & Alignment:
- **WhisperX v3.8:** Ensure the alignment model matches the language exactly (e.g., `WAV2VEC2_ASR_LARGE_LV60K_960H` for English).
- **Librosa v0.11:** Use `librosa.onset.onset_detect` with a custom `backtrack=True` to find the exact frame where a "Mikup" event (like a door slam) begins.
