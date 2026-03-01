# Transcriber Rewrite: whisperx → faster-whisper + pyannote

**Date:** 2026-02-27
**Status:** Approved

## Problem

`whisperx` is excluded from `requirements.txt` because it pins `torch~=2.8`, conflicting with the project's `torch==2.10.0` stack. Without it, Stage 2 writes an empty `{"segments": []}`, producing no pacing mikups, no transcript, and a hollow AI Director report.

`faster-whisper` and `pyannote.audio` — the two libraries whisperx wraps internally — are already installed in the venv.

## Approach

Drop-in internal replacement of `src/transcription/transcriber.py`. Same class name, same three public methods, same output JSON schema. `main.py` is untouched.

## Architecture

### Engines

| Engine | Purpose | Mac (Apple Silicon) | Windows (RTX 3070 Ti) |
|---|---|---|---|
| `faster-whisper` (CTranslate2) | Transcription + word timestamps | `device="cpu"`, `compute_type="int8"` | `device="cuda"`, `compute_type="float16"` |
| `pyannote.audio` (PyTorch) | Speaker diarization | `torch_device="mps"` | `torch_device="cuda"` |

CTranslate2 has no MPS backend — faster-whisper always uses CPU on Mac. int8 on Apple Silicon is fast in practice. Pyannote uses PyTorch and gets MPS acceleration on Mac.

### Device Auto-detection

`__init__` detects hardware at construction time. No `device`/`compute_type` arguments needed.

```python
if torch.cuda.is_available():
    ct2_device, ct2_compute = "cuda", "float16"
    torch_device = "cuda"
elif torch.backends.mps.is_available():
    ct2_device, ct2_compute = "cpu", "int8"
    torch_device = "mps"
else:
    ct2_device, ct2_compute = "cpu", "int8"
    torch_device = "cpu"
```

### Model

`WhisperModel("small", ...)` — ~245MB, good balance of speed and accuracy for audio drama dialogue.

## Data Flow

### `transcribe(audio_path)`

1. Load `WhisperModel("small", device=ct2_device, compute_type=ct2_compute)`
2. Call `model.transcribe(audio_path, word_timestamps=True)`
3. Consume the segment generator, building:
   - `segments`: `[{start, end, text, speaker: "UNKNOWN"}]`
   - `word_segments`: `[{word, start, end}]` (flattened from all segment words)
4. Return `{"segments": [...], "word_segments": [...]}`

### `diarize(audio_path, transcription_result, hf_token)`

1. Load `Pipeline.from_pretrained("pyannote/speaker-diarization-3.1", use_auth_token=hf_token)` on `torch_device`
2. Run pipeline on `audio_path` → diarization timeline
3. For each segment, find speaker with max time-overlap across diarization turns → assign `segment["speaker"]`
4. Return updated `transcription_result`

### `save_results(result, output_path)`

Unchanged — writes result dict as JSON.

## Output Schema (unchanged)

```json
{
  "segments": [
    { "start": 0.0, "end": 2.4, "text": "Hello.", "speaker": "SPEAKER_00" }
  ],
  "word_segments": [
    { "word": "Hello", "start": 0.0, "end": 0.6 }
  ]
}
```

## Error Handling

- Pyannote failure (bad HF token, gated model not accepted, network error) → log warning, return segments with `speaker: "UNKNOWN"`. Pipeline continues.
- faster-whisper produces no segments → return `{"segments": [], "word_segments": []}`. Pacing will be empty but no crash.

## requirements.txt

Add a cross-platform note above `onnxruntime`:

```
# macOS: onnxruntime  |  Windows (CUDA): replace with onnxruntime-gpu
onnxruntime
```

## Files Changed

| File | Change |
|---|---|
| `src/transcription/transcriber.py` | Full rewrite (same public API) |
| `requirements.txt` | Add cross-platform onnxruntime comment |
