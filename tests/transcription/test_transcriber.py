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
