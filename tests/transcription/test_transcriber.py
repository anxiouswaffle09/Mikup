import json
import os
import sys
import types
from unittest.mock import MagicMock, patch

import pytest

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

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


# ── speaker assignment ────────────────────────────────────────────────────────

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


# ── transcribe() ──────────────────────────────────────────────────────────────

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


# ── diarize() ─────────────────────────────────────────────────────────────────

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
