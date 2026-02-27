import json
import os
import sys
import subprocess
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.main import validate_stage_artifacts


# ─── separation ───────────────────────────────────────────────────────────────

def test_separation_valid(tmp_path):
    dialogue = tmp_path / "vocals.wav"
    background = tmp_path / "instru.wav"
    dialogue.write_bytes(b"RIFF")
    background.write_bytes(b"RIFF")
    stems_json = tmp_path / "stems.json"
    stems_json.write_text(json.dumps({
        "dialogue_raw": str(dialogue),
        "background_raw": str(background),
    }))
    assert validate_stage_artifacts("separation", str(tmp_path)) is True


def test_separation_missing_stems_json(tmp_path):
    assert validate_stage_artifacts("separation", str(tmp_path)) is False


def test_separation_wav_missing(tmp_path):
    stems_json = tmp_path / "stems.json"
    stems_json.write_text(json.dumps({
        "dialogue_raw": str(tmp_path / "nonexistent.wav"),
        "background_raw": str(tmp_path / "also_missing.wav"),
    }))
    assert validate_stage_artifacts("separation", str(tmp_path)) is False


# ─── transcription ────────────────────────────────────────────────────────────

def test_transcription_valid(tmp_path):
    (tmp_path / "transcription.json").write_text(json.dumps({"segments": []}))
    assert validate_stage_artifacts("transcription", str(tmp_path)) is True


def test_transcription_missing(tmp_path):
    assert validate_stage_artifacts("transcription", str(tmp_path)) is False


def test_transcription_bad_shape(tmp_path):
    (tmp_path / "transcription.json").write_text(json.dumps({"not_segments": 42}))
    assert validate_stage_artifacts("transcription", str(tmp_path)) is False


# ─── dsp ──────────────────────────────────────────────────────────────────────

def test_dsp_valid(tmp_path):
    (tmp_path / "dsp_metrics.json").write_text(json.dumps({"key": "value"}))
    assert validate_stage_artifacts("dsp", str(tmp_path)) is True


def test_dsp_empty_dict(tmp_path):
    (tmp_path / "dsp_metrics.json").write_text(json.dumps({}))
    assert validate_stage_artifacts("dsp", str(tmp_path)) is False


def test_dsp_missing(tmp_path):
    assert validate_stage_artifacts("dsp", str(tmp_path)) is False


# ─── semantics ────────────────────────────────────────────────────────────────

def test_semantics_valid_empty_list(tmp_path):
    (tmp_path / "semantics.json").write_text(json.dumps([]))
    assert validate_stage_artifacts("semantics", str(tmp_path)) is True


def test_semantics_valid_with_tags(tmp_path):
    (tmp_path / "semantics.json").write_text(json.dumps([{"label": "rain", "score": 0.9}]))
    assert validate_stage_artifacts("semantics", str(tmp_path)) is True


def test_semantics_missing(tmp_path):
    assert validate_stage_artifacts("semantics", str(tmp_path)) is False


def test_semantics_wrong_type(tmp_path):
    (tmp_path / "semantics.json").write_text(json.dumps({"oops": "dict"}))
    assert validate_stage_artifacts("semantics", str(tmp_path)) is False


# ─── director ─────────────────────────────────────────────────────────────────

def test_director_valid(tmp_path):
    (tmp_path / "mikup_payload.json").write_text(json.dumps({"metadata": {}}))
    assert validate_stage_artifacts("director", str(tmp_path)) is True


def test_director_missing(tmp_path):
    assert validate_stage_artifacts("director", str(tmp_path)) is False


def test_director_empty(tmp_path):
    (tmp_path / "mikup_payload.json").write_text(json.dumps({}))
    assert validate_stage_artifacts("director", str(tmp_path)) is False


# ─── unknown stage ────────────────────────────────────────────────────────────

def test_unknown_stage_returns_false(tmp_path):
    assert validate_stage_artifacts("bogus", str(tmp_path)) is False
