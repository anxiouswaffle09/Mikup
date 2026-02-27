# Transcriber Rewrite Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace `src/transcription/transcriber.py` internals to use `faster-whisper` + `pyannote.audio` directly, restoring Stage 2 (transcription + diarization) without whisperx.

**Architecture:** Same public API (`MikupTranscriber`, `transcribe()`, `diarize()`, `save_results()`), zero changes to `main.py`. Device (CUDA / MPS / CPU) is auto-detected at init. `faster-whisper` handles transcription with word timestamps; `pyannote/speaker-diarization-3.1` handles speaker assignment.

**Tech Stack:** `faster-whisper==1.2.1`, `pyannote.audio==4.0.4`, `pytest` (new dev dep), `unittest.mock` (stdlib)

---

### Task 1: Install pytest and scaffold test directory

**Files:**
- Create: `tests/__init__.py`
- Create: `tests/transcription/__init__.py`
- Create: `tests/transcription/test_transcriber.py` (skeleton only)

**Step 1: Install pytest**

```bash
.venv/bin/pip install pytest
```

Expected: `Successfully installed pytest-...`

**Step 2: Create test directory structure**

```bash
mkdir -p tests/transcription
touch tests/__init__.py tests/transcription/__init__.py
```

**Step 3: Create skeleton test file**

Create `tests/transcription/test_transcriber.py`:

```python
import json
import os
import sys
import types
from unittest.mock import MagicMock, patch

import pytest

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)
```

**Step 4: Verify pytest discovers the file**

```bash
.venv/bin/python3 -m pytest tests/transcription/test_transcriber.py --collect-only
```

Expected: `no tests ran` (skeleton only, no errors)

**Step 5: Commit**

```bash
git add tests/ && git commit -m "test: scaffold transcriber test directory"
```

---

### Task 2: Test and implement device auto-detection

**Files:**
- Modify: `tests/transcription/test_transcriber.py`
- Modify: `src/transcription/transcriber.py`

**Step 1: Add failing tests for `_detect_devices`**

Append to `tests/transcription/test_transcriber.py`:

```python
from src.transcription.transcriber import MikupTranscriber, _detect_devices


# ── helpers ──────────────────────────────────────────────────────────────────

def _make_fw_segment(start, end, text, words=None):
    return types.SimpleNamespace(start=start, end=end, text=text, words=words or [])

def _make_fw_word(word, start, end):
    return types.SimpleNamespace(word=word, start=start, end=end)

def _make_diarization(turns):
    """turns: list of (start, end, speaker) tuples"""
    class FakeTurn:
        def __init__(self, s, e):
            self.start = s
            self.end = e
    def itertracks(yield_label=False):
        for s, e, spk in turns:
            yield FakeTurn(s, e), None, spk
    d = MagicMock()
    d.itertracks = itertracks
    return d


# ── device detection ─────────────────────────────────────────────────────────

class TestDetectDevices:
    def test_returns_three_values(self):
        result = _detect_devices()
        assert len(result) == 3

    def test_cpu_fallback(self):
        with patch("torch.cuda.is_available", return_value=False), \
             patch("torch.backends.mps.is_available", return_value=False):
            ct2_device, ct2_compute, torch_device = _detect_devices()
        assert (ct2_device, ct2_compute, torch_device) == ("cpu", "int8", "cpu")

    def test_cuda_path(self):
        with patch("torch.cuda.is_available", return_value=True):
            ct2_device, ct2_compute, torch_device = _detect_devices()
        assert (ct2_device, ct2_compute, torch_device) == ("cuda", "float16", "cuda")

    def test_mps_path_uses_cpu_for_ct2(self):
        with patch("torch.cuda.is_available", return_value=False), \
             patch("torch.backends.mps.is_available", return_value=True):
            ct2_device, ct2_compute, torch_device = _detect_devices()
        assert ct2_device == "cpu"     # CTranslate2 has no MPS backend
        assert ct2_compute == "int8"
        assert torch_device == "mps"   # pyannote uses MPS via PyTorch
```

**Step 2: Run — verify failure**

```bash
.venv/bin/python3 -m pytest tests/transcription/test_transcriber.py::TestDetectDevices -v
```

Expected: `ImportError: cannot import name '_detect_devices'`

**Step 3: Rewrite `src/transcription/transcriber.py`**

Replace the entire file:

```python
import logging
import json
import os

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def _detect_devices():
    """Auto-detect best available compute device for each engine.

    Returns:
        ct2_device   — faster-whisper/CTranslate2 device ("cpu" or "cuda")
        ct2_compute  — CTranslate2 compute type ("int8" or "float16")
        torch_device — PyTorch device string for pyannote ("cpu", "cuda", "mps")
    """
    import torch
    if torch.cuda.is_available():
        return "cuda", "float16", "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        # CTranslate2 has no MPS backend — faster-whisper must use CPU.
        # pyannote (pure PyTorch) can use MPS.
        return "cpu", "int8", "mps"
    return "cpu", "int8", "cpu"


class MikupTranscriber:
    """
    Stage 2: Transcription and Speaker Diarization.
    Uses faster-whisper for transcription (word timestamps included)
    and pyannote.audio for speaker diarization.
    Same public API as the previous whisperx-based implementation.
    """

    def __init__(self, model_size="small"):
        self.model_size = model_size
        self.ct2_device, self.ct2_compute, self.torch_device = _detect_devices()
        logger.info(
            "MikupTranscriber: faster-whisper on %s/%s, pyannote on %s",
            self.ct2_device, self.ct2_compute, self.torch_device,
        )

    @staticmethod
    def _assign_speaker(seg_start, seg_end, diarization):
        """Return the speaker label with the most overlap in [seg_start, seg_end]."""
        speaker_overlap = {}
        for turn, _, speaker in diarization.itertracks(yield_label=True):
            overlap = min(seg_end, turn.end) - max(seg_start, turn.start)
            if overlap > 0:
                speaker_overlap[speaker] = speaker_overlap.get(speaker, 0) + overlap
        if not speaker_overlap:
            return "UNKNOWN"
        return max(speaker_overlap, key=speaker_overlap.get)

    def transcribe(self, audio_path, batch_size=16):
        """
        Transcribe audio using faster-whisper with word-level timestamps.
        batch_size is accepted for API compatibility but not used.

        Returns:
            {
                "segments":      [{start, end, text, speaker: "UNKNOWN"}, ...],
                "word_segments": [{word, start, end}, ...]
            }
        """
        from faster_whisper import WhisperModel

        logger.info(
            "Loading WhisperModel (%s) on %s / %s...",
            self.model_size, self.ct2_device, self.ct2_compute,
        )
        model = WhisperModel(
            self.model_size,
            device=self.ct2_device,
            compute_type=self.ct2_compute,
        )

        logger.info("Transcribing: %s", audio_path)
        fw_segments, _ = model.transcribe(audio_path, word_timestamps=True)

        segments = []
        word_segments = []

        for seg in fw_segments:
            segments.append({
                "start": seg.start,
                "end": seg.end,
                "text": seg.text.strip(),
                "speaker": "UNKNOWN",
            })
            if seg.words:
                for w in seg.words:
                    word_segments.append({
                        "word": w.word,
                        "start": w.start,
                        "end": w.end,
                    })

        logger.info(
            "Transcription complete: %d segments, %d words.",
            len(segments), len(word_segments),
        )
        return {"segments": segments, "word_segments": word_segments}

    def diarize(self, audio_path, transcription_result, hf_token=None):
        """
        Assign speaker labels to segments using pyannote/speaker-diarization-3.1.
        If hf_token is absent or the pipeline fails, returns result unchanged
        (segments keep speaker: "UNKNOWN").
        """
        if not hf_token:
            logger.warning("HF_TOKEN not provided. Skipping diarization.")
            return transcription_result

        try:
            from pyannote.audio import Pipeline
            import torch

            logger.info(
                "Loading pyannote diarization pipeline on %s...", self.torch_device
            )
            pipeline = Pipeline.from_pretrained(
                "pyannote/speaker-diarization-3.1",
                use_auth_token=hf_token,
            )
            pipeline.to(torch.device(self.torch_device))

            logger.info("Running diarization on: %s", audio_path)
            diarization = pipeline(audio_path)

            for segment in transcription_result.get("segments", []):
                segment["speaker"] = self._assign_speaker(
                    segment["start"], segment["end"], diarization
                )

            logger.info("Diarization complete.")

        except Exception as exc:
            logger.warning(
                "Diarization failed (%s: %s) — continuing with UNKNOWN speakers.",
                type(exc).__name__, exc,
            )

        return transcription_result

    def save_results(self, result, output_path):
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
        logger.info("Transcription results saved to %s", output_path)
```

**Step 4: Run — verify tests pass**

```bash
.venv/bin/python3 -m pytest tests/transcription/test_transcriber.py::TestDetectDevices -v
```

Expected: `4 passed`

**Step 5: Commit**

```bash
git add src/transcription/transcriber.py tests/transcription/test_transcriber.py
git commit -m "feat: implement _detect_devices with CUDA/MPS/CPU auto-detection"
```

---

### Task 3: Test and implement speaker assignment

**Files:**
- Modify: `tests/transcription/test_transcriber.py`

**Step 1: Add failing tests for `_assign_speaker`**

Append to `tests/transcription/test_transcriber.py`:

```python
class TestAssignSpeaker:
    def test_single_speaker_full_overlap(self):
        d = _make_diarization([(0.0, 5.0, "SPEAKER_00")])
        assert MikupTranscriber._assign_speaker(1.0, 3.0, d) == "SPEAKER_00"

    def test_no_overlap_returns_unknown(self):
        d = _make_diarization([(10.0, 20.0, "SPEAKER_00")])
        assert MikupTranscriber._assign_speaker(0.0, 1.0, d) == "UNKNOWN"

    def test_picks_majority_speaker(self):
        # SPEAKER_00: 2s overlap, SPEAKER_01: 0.5s overlap
        d = _make_diarization([
            (0.0, 2.0, "SPEAKER_00"),
            (2.0, 2.5, "SPEAKER_01"),
        ])
        assert MikupTranscriber._assign_speaker(0.0, 2.5, d) == "SPEAKER_00"

    def test_empty_diarization_returns_unknown(self):
        d = _make_diarization([])
        assert MikupTranscriber._assign_speaker(0.0, 1.0, d) == "UNKNOWN"

    def test_partial_overlap_counted(self):
        # segment 1.0–3.0, speaker turn 2.0–5.0 → 1s overlap
        d = _make_diarization([(2.0, 5.0, "SPEAKER_01")])
        assert MikupTranscriber._assign_speaker(1.0, 3.0, d) == "SPEAKER_01"
```

**Step 2: Run — verify pass (implementation already exists)**

```bash
.venv/bin/python3 -m pytest tests/transcription/test_transcriber.py::TestAssignSpeaker -v
```

Expected: `5 passed`

**Step 3: Commit**

```bash
git add tests/transcription/test_transcriber.py
git commit -m "test: add speaker assignment tests"
```

---

### Task 4: Test `transcribe()` with mocked WhisperModel

**Files:**
- Modify: `tests/transcription/test_transcriber.py`

**Step 1: Add failing tests**

Append to `tests/transcription/test_transcriber.py`:

```python
class TestTranscribe:
    def _transcriber(self):
        with patch("src.transcription.transcriber._detect_devices",
                   return_value=("cpu", "int8", "cpu")):
            return MikupTranscriber()

    def _mock_model(self, segments):
        m = MagicMock()
        m.transcribe.return_value = (iter(segments), MagicMock())
        return m

    def test_segments_and_word_segments_populated(self):
        t = self._transcriber()
        words = [_make_fw_word("Hello", 0.0, 0.4), _make_fw_word("world", 0.5, 0.9)]
        seg = _make_fw_segment(0.0, 1.0, " Hello world", words=words)

        with patch("faster_whisper.WhisperModel", return_value=self._mock_model([seg])):
            result = t.transcribe("fake.wav")

        assert len(result["segments"]) == 1
        assert result["segments"][0] == {
            "start": 0.0, "end": 1.0, "text": "Hello world", "speaker": "UNKNOWN"
        }
        assert result["word_segments"] == [
            {"word": "Hello", "start": 0.0, "end": 0.4},
            {"word": "world", "start": 0.5, "end": 0.9},
        ]

    def test_empty_audio_returns_empty_lists(self):
        t = self._transcriber()
        with patch("faster_whisper.WhisperModel", return_value=self._mock_model([])):
            result = t.transcribe("fake.wav")
        assert result == {"segments": [], "word_segments": []}

    def test_segment_without_words_still_included(self):
        t = self._transcriber()
        seg = _make_fw_segment(0.0, 1.0, "No words", words=None)
        with patch("faster_whisper.WhisperModel", return_value=self._mock_model([seg])):
            result = t.transcribe("fake.wav")
        assert len(result["segments"]) == 1
        assert result["word_segments"] == []

    def test_speaker_defaults_to_unknown(self):
        t = self._transcriber()
        seg = _make_fw_segment(1.0, 2.0, "test")
        with patch("faster_whisper.WhisperModel", return_value=self._mock_model([seg])):
            result = t.transcribe("fake.wav")
        assert result["segments"][0]["speaker"] == "UNKNOWN"

    def test_text_is_stripped(self):
        t = self._transcriber()
        seg = _make_fw_segment(0.0, 1.0, "  padded  ")
        with patch("faster_whisper.WhisperModel", return_value=self._mock_model([seg])):
            result = t.transcribe("fake.wav")
        assert result["segments"][0]["text"] == "padded"
```

**Step 2: Run — verify all pass**

```bash
.venv/bin/python3 -m pytest tests/transcription/test_transcriber.py::TestTranscribe -v
```

Expected: `5 passed`

**Step 3: Commit**

```bash
git add tests/transcription/test_transcriber.py
git commit -m "test: add transcribe() unit tests with mocked WhisperModel"
```

---

### Task 5: Test `diarize()` with mocked pyannote Pipeline

**Files:**
- Modify: `tests/transcription/test_transcriber.py`

**Step 1: Add failing tests**

Append to `tests/transcription/test_transcriber.py`:

```python
class TestDiarize:
    def _transcriber(self):
        with patch("src.transcription.transcriber._detect_devices",
                   return_value=("cpu", "int8", "cpu")):
            return MikupTranscriber()

    def _base_result(self):
        return {
            "segments": [
                {"start": 0.0, "end": 2.0, "text": "Hello", "speaker": "UNKNOWN"},
                {"start": 3.0, "end": 5.0, "text": "World", "speaker": "UNKNOWN"},
            ],
            "word_segments": [],
        }

    def test_no_token_returns_result_unchanged(self):
        t = self._transcriber()
        result = self._base_result()
        out = t.diarize("fake.wav", result, hf_token=None)
        assert all(s["speaker"] == "UNKNOWN" for s in out["segments"])

    def test_assigns_speaker_labels(self):
        t = self._transcriber()
        result = self._base_result()
        diarization = _make_diarization([
            (0.0, 2.5, "SPEAKER_00"),
            (2.5, 6.0, "SPEAKER_01"),
        ])
        mock_pipeline = MagicMock(return_value=diarization)
        with patch("pyannote.audio.Pipeline.from_pretrained", return_value=mock_pipeline):
            out = t.diarize("fake.wav", result, hf_token="fake_token")
        assert out["segments"][0]["speaker"] == "SPEAKER_00"
        assert out["segments"][1]["speaker"] == "SPEAKER_01"

    def test_pipeline_failure_returns_result_unchanged(self):
        t = self._transcriber()
        result = self._base_result()
        with patch("pyannote.audio.Pipeline.from_pretrained",
                   side_effect=RuntimeError("auth failed")):
            out = t.diarize("fake.wav", result, hf_token="bad_token")
        assert all(s["speaker"] == "UNKNOWN" for s in out["segments"])

    def test_empty_segments_no_crash(self):
        t = self._transcriber()
        result = {"segments": [], "word_segments": []}
        diarization = _make_diarization([])
        mock_pipeline = MagicMock(return_value=diarization)
        with patch("pyannote.audio.Pipeline.from_pretrained", return_value=mock_pipeline):
            out = t.diarize("fake.wav", result, hf_token="tok")
        assert out["segments"] == []
```

**Step 2: Run — verify all pass**

```bash
.venv/bin/python3 -m pytest tests/transcription/test_transcriber.py::TestDiarize -v
```

Expected: `4 passed`

**Step 3: Commit**

```bash
git add tests/transcription/test_transcriber.py
git commit -m "test: add diarize() unit tests with mocked pyannote Pipeline"
```

---

### Task 6: Test and verify `save_results()`

**Files:**
- Modify: `tests/transcription/test_transcriber.py`

**Step 1: Add test**

Append to `tests/transcription/test_transcriber.py`:

```python
class TestSaveResults:
    def _transcriber(self):
        with patch("src.transcription.transcriber._detect_devices",
                   return_value=("cpu", "int8", "cpu")):
            return MikupTranscriber()

    def test_writes_valid_json(self, tmp_path):
        t = self._transcriber()
        result = {
            "segments": [{"start": 0.0, "end": 1.0, "text": "Hi", "speaker": "SPEAKER_00"}],
            "word_segments": [{"word": "Hi", "start": 0.0, "end": 0.3}],
        }
        out_path = tmp_path / "out.json"
        t.save_results(result, str(out_path))
        assert json.loads(out_path.read_text()) == result

    def test_creates_file_at_path(self, tmp_path):
        t = self._transcriber()
        out_path = tmp_path / "sub" / "out.json"
        out_path.parent.mkdir()
        t.save_results({"segments": [], "word_segments": []}, str(out_path))
        assert out_path.exists()
```

**Step 2: Run full test suite**

```bash
.venv/bin/python3 -m pytest tests/transcription/test_transcriber.py -v
```

Expected: all tests pass

**Step 3: Commit**

```bash
git add tests/transcription/test_transcriber.py
git commit -m "test: add save_results() tests; all transcriber tests passing"
```

---

### Task 7: Update requirements.txt with cross-platform onnxruntime note

**Files:**
- Modify: `requirements.txt`

**Step 1: Add the comment**

Find the `onnxruntime` line and replace it with:

```
# macOS: onnxruntime  |  Windows (CUDA): swap for onnxruntime-gpu
onnxruntime
```

**Step 2: Verify no accidental changes**

```bash
git diff requirements.txt
```

Expected: only the comment line added above `onnxruntime`.

**Step 3: Commit**

```bash
git add requirements.txt
git commit -m "docs: add cross-platform onnxruntime note for Windows/CUDA"
```

---

### Task 8: Full test suite run and final verification

**Step 1: Run all tests**

```bash
.venv/bin/python3 -m pytest tests/ -v
```

Expected: all tests pass, no warnings about import errors.

**Step 2: Smoke-test the import chain used by main.py**

```bash
.venv/bin/python3 -c "
from src.transcription.transcriber import MikupTranscriber
t = MikupTranscriber()
print('ct2_device:', t.ct2_device)
print('torch_device:', t.torch_device)
print('OK')
"
```

Expected: prints device values and `OK`.

**Step 3: Run diagnostic**

```bash
.venv/bin/python3 diagnostic.py
```

Expected: no new failures vs. previous run.

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat: replace whisperx with faster-whisper + pyannote in Stage 2

- Auto-detects CUDA / MPS / CPU at init
- faster-whisper 'small' for transcription with word timestamps
- pyannote/speaker-diarization-3.1 for speaker assignment
- Diarization failure degrades gracefully (UNKNOWN speakers)
- Full unit test coverage with mocked engines

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```
