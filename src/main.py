import os
import shutil
import argparse
import json
import gc
import sys
import uuid
import threading
import torch
import logging
import time
import math
from pathlib import Path
from datetime import datetime
from dataclasses import dataclass, field
from typing import Any, TypeVar

from dotenv import load_dotenv
from pydantic import BaseModel, Field, ValidationError

logging.basicConfig(level=logging.INFO, format='%(message)s')
logger = logging.getLogger(__name__)

# Allow running as either `python src/main.py` or `python -m src.main`.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if __package__ in (None, ""):
    _root_str = str(PROJECT_ROOT)
    if _root_str not in sys.path:
        sys.path.insert(0, _root_str)

# ---------------------------------------------------------------------------
# PyTorch 2.10+ security: register trusted model classes before any imports
# that may trigger model loading. This must run before Mikup module imports.
# ---------------------------------------------------------------------------
from src.bootstrap import _register_torch_safe_globals, check_model_integrity
_register_torch_safe_globals()
check_model_integrity()
# ---------------------------------------------------------------------------

from src.ingestion.separator import MikupSeparator
from src.transcription.transcriber import MikupTranscriber
from src.semantics.tagger import MikupSemanticTagger
from src.llm.director import MikupDirector

# Load environment variables
load_dotenv()


# ---------------------------------------------------------------------------
# No-GIL–optimised data structures (slots=True for interpreter efficiency)
# ---------------------------------------------------------------------------

@dataclass(slots=True)
class StageInfo:
    completed: bool = False
    timestamp: str | None = None
    artifacts: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class StemsManifest:
    DX: str | None = None
    Music: str | None = None
    Effects: str | None = None
    DX_Residual: str | None = None


@dataclass(slots=True)
class TranscriptionPayload:
    segments: list[dict] = field(default_factory=list)
    pacing_mikups: list[dict] = field(default_factory=list)


@dataclass(slots=True)
class PayloadMetadata:
    source_file: str = "Unknown"
    pipeline_version: str = "0.2.0-beta"
    timestamp: str = ""
    is_complete: bool = False


@dataclass(slots=True)
class SemanticTag:
    label: str = ""
    score: float | None = None


# ---------------------------------------------------------------------------
# Pydantic models — top-level JSON serialization/deserialization boundaries
# ---------------------------------------------------------------------------

class StageState(BaseModel):
    source_file: str | None = None
    source_mtime: float | None = None
    output_dir: str | None = None
    fast_mode: bool = False
    mock_mode: bool = False
    selected_stage: str | None = None
    artifacts: dict[str, str] = Field(default_factory=dict)
    stems: dict[str, str | None] = Field(default_factory=dict)
    output_payload: str | None = None
    updated_at: str | None = None
    stages: dict[str, StageInfo] = Field(default_factory=dict)


class MikupPayload(BaseModel):
    is_complete: bool = False
    metadata: PayloadMetadata = Field(default_factory=PayloadMetadata)
    transcription: dict = Field(default_factory=lambda: {"segments": []})
    metrics: dict = Field(default_factory=dict)
    semantics: dict = Field(default_factory=lambda: {"background_tags": []})
    artifacts: dict = Field(default_factory=dict)
    ai_report: str | None = None


# ---------------------------------------------------------------------------
# Module-level lock for No-GIL thread safety on file writes & state mutations
# ---------------------------------------------------------------------------

_state_lock = threading.RLock()

# Generic type for Pydantic model parameter
_M = TypeVar("_M", bound=BaseModel)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

STAGE_CHOICES = ("separation", "transcription", "dsp", "semantics", "director")
REDO_STAGE_CHOICES = ("separation", "transcription", "dsp", "semantics", "llm")
PIPELINE_ORDER = ("separation", "transcription", "dsp", "semantics", "director")
REDO_STAGE_ALIASES = {
    "separation": "separation",
    "transcription": "transcription",
    "dsp": "dsp",
    "semantics": "semantics",
    "llm": "director",
    # Backwards-compatible alias.
    "director": "director",
}
CANONICAL_STEM_KEYS = ("DX", "Music", "Effects")
OPTIONAL_STEM_KEYS = ("DX_Residual",)

# Keep a str alias for code that still references `project_root` by name
project_root = str(PROJECT_ROOT)


def flush_vram():
    """Forcefully clear VRAM and RAM cache."""
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        pass


def emit_progress(stage, progress, message):
    """Emit a JSON progress marker to stdout for the native UI to capture."""
    print(json.dumps({
        "type": "progress",
        "stage": stage,
        "progress": progress,
        "message": message,
        "timestamp": time.time()
    }), flush=True)


def is_existing_file(path) -> bool:
    if not isinstance(path, (str, Path)) or (isinstance(path, str) and not path.strip()):
        return False
    return Path(path).exists()


def ensure_directory(path):
    p = Path(path)
    p.mkdir(parents=True, exist_ok=True)
    return str(p)


def ensure_output_dir(output_path):
    p = Path(output_path)
    parent = p.parent
    parent.mkdir(parents=True, exist_ok=True)
    return str(parent)


def write_empty_transcription(path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"segments": []}, f)


def _read_json_file(path, default=None, model: type[_M] | None = None):
    """Read a JSON file and optionally validate with a Pydantic model.

    When *model* is supplied, the parsed dict is validated through
    ``model.model_validate()`` and the resulting BaseModel instance is
    returned. On validation failure the raw dict is returned instead so
    callers never crash on legacy data.
    """
    if not is_existing_file(path):
        return default
    with _state_lock:
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if model is not None and isinstance(data, dict):
                try:
                    return model.model_validate(data)
                except ValidationError as exc:
                    logger.warning(
                        "Validation failed for %s with model %s: %s",
                        path,
                        model.__name__,
                        exc,
                    )
                    return data
            return data
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("Failed to read JSON from %s: %s", path, exc)
            return default


def _write_json_file(path, payload):
    with _state_lock:
        ensure_output_dir(path)
        data = payload.model_dump() if isinstance(payload, BaseModel) else payload
        target = Path(path)
        tmp_path = target.with_name(f".{target.name}.{os.getpid()}.tmp")
        try:
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, target)
        finally:
            if tmp_path.exists():
                try:
                    tmp_path.unlink()
                except OSError:
                    pass


def _artifact_paths(output_dir):
    data_dir = Path(ensure_directory(str(Path(output_dir) / "data")))
    return {
        "stage_state": str(data_dir / "stage_state.json"),
        "stems": str(data_dir / "stems.json"),
        "transcription": str(data_dir / "transcription.json"),
        "semantics": str(data_dir / "semantics.json"),
        "dsp_metrics": str(data_dir / "dsp_metrics.json"),
    }


def _safe_remove_path(path):
    if not isinstance(path, (str, Path)):
        return
    p = Path(path)
    if isinstance(path, str) and not path.strip():
        return
    if not p.exists():
        return
    try:
        if p.is_dir():
            shutil.rmtree(p)
        else:
            p.unlink()
    except OSError as exc:
        logger.warning("Failed to delete artifact %s: %s", p, exc)


def _normalize_redo_stage(stage_name: str) -> str:
    normalized = str(stage_name or "").strip().lower()
    return REDO_STAGE_ALIASES.get(normalized, normalized)


def _parse_redo_stage(value: str) -> str:
    normalized = _normalize_redo_stage(value)
    if normalized == "director":
        return "llm"
    if normalized not in REDO_STAGE_CHOICES:
        raise argparse.ArgumentTypeError(
            f"Invalid --redo-stage '{value}'. Choose from: {', '.join(REDO_STAGE_CHOICES)}"
        )
    return normalized


def _redo_invalidation_sequence(start_stage_name: str) -> list[str]:
    internal_stage_name = _normalize_redo_stage(start_stage_name)
    if internal_stage_name not in PIPELINE_ORDER:
        raise ValueError(
            f"Unknown stage '{start_stage_name}'. Expected one of: {', '.join(REDO_STAGE_CHOICES)}"
        )
    start_index = PIPELINE_ORDER.index(internal_stage_name)
    return list(PIPELINE_ORDER[start_index:])


def _stage_invalidation_paths(stage_name, output_dir, artifacts, stage_state):
    paths = set()
    out = Path(output_dir)
    stages = stage_state.get("stages") if isinstance(stage_state, dict) else {}
    stage_meta = stages.get(stage_name) if isinstance(stages, dict) else {}
    stage_artifacts = stage_meta.get("artifacts") if isinstance(stage_meta, dict) else {}
    stage_dirs = {
        "separation": (out / "stems",),
        "transcription": (out / "transcription",),
        "dsp": (out / "dsp",),
        "semantics": (out / "semantics",),
        "director": (out / "llm", out / "director"),
    }

    if isinstance(stage_artifacts, dict):
        for artifact_path in stage_artifacts.values():
            if isinstance(artifact_path, str):
                paths.add(artifact_path)

    for directory in stage_dirs.get(stage_name, ()):
        paths.add(str(directory))

    if stage_name == "separation":
        stems_manifest = artifacts.get("stems")
        if isinstance(stems_manifest, str):
            paths.add(stems_manifest)
        stems = _read_json_file(stems_manifest, default={})
        if isinstance(stems, dict):
            for stem_path in stems.values():
                if isinstance(stem_path, str):
                    paths.add(stem_path)
    elif stage_name == "transcription":
        transcription_path = artifacts.get("transcription")
        if isinstance(transcription_path, str):
            paths.add(transcription_path)
    elif stage_name == "dsp":
        dsp_metrics_path = artifacts.get("dsp_metrics")
        if isinstance(dsp_metrics_path, str):
            paths.add(dsp_metrics_path)
    elif stage_name == "semantics":
        semantics_path = artifacts.get("semantics")
        if isinstance(semantics_path, str):
            paths.add(semantics_path)
    elif stage_name == "director":
        paths.add(str(out / "mikup_payload.json"))
        paths.add(str(out / "mikup_report.md"))
        paths.add(str(out / "data" / ".mikup_context.md"))
        output_payload = artifacts.get("output_payload")
        if isinstance(output_payload, str):
            paths.add(output_payload)

    return {path for path in paths if isinstance(path, str) and path.strip()}


def invalidate_stages(start_stage_name: str, output_dir: str, artifacts, stage_state) -> list[str]:
    stages_to_invalidate = _redo_invalidation_sequence(start_stage_name)
    project_id = Path(output_dir).name or str(Path(output_dir).resolve())

    with _state_lock:
        logger.info(
            "Redoing stage '%s'. Purging downstream artifacts for project: %s",
            start_stage_name,
            project_id,
        )
        stages_block = stage_state.get("stages")
        if not isinstance(stages_block, dict):
            stages_block = {}

        for stage_name in stages_to_invalidate:
            for artifact_path in _stage_invalidation_paths(stage_name, output_dir, artifacts, stage_state):
                _safe_remove_path(artifact_path)

            stage_entry = stages_block.get(stage_name)
            if not isinstance(stage_entry, dict):
                stage_entry = {}

            stage_entry["completed"] = False
            stage_entry["is_complete"] = False
            stage_entry["artifacts"] = {}
            stage_entry["timestamp"] = None
            stages_block[stage_name] = stage_entry

        stage_state["stages"] = stages_block
        stage_state["updated_at"] = datetime.now().isoformat()

    return stages_to_invalidate


def _invalidate_redo_stages(args, output_dir, artifacts, stage_state):
    if not args.redo_stage:
        return set()
    return set(
        invalidate_stages(
            start_stage_name=str(args.redo_stage),
            output_dir=output_dir,
            artifacts=artifacts,
            stage_state=stage_state,
        )
    )


def _extract_canonical_stems(stems):
    if not isinstance(stems, dict):
        return {}

    key_aliases = {
        "DX": ("DX", "dialogue_dry", "dialogue_raw"),
        "Music": ("Music", "music"),
        "Effects": ("Effects", "effects", "background_raw"),
        "DX_Residual": ("DX_Residual", "reverb_tail"),
    }

    normalized = {}
    for canonical_key, aliases in key_aliases.items():
        normalized[canonical_key] = None
        for alias in aliases:
            value = stems.get(alias)
            if isinstance(value, str) and value.strip():
                normalized[canonical_key] = value
                break

    return normalized


def _mark_stage_complete(state, stage_name, artifacts=None):
    stages = state.setdefault("stages", {})
    stage_state = stages.setdefault(stage_name, {})
    stage_state["completed"] = True
    stage_state["is_complete"] = True
    stage_state["timestamp"] = datetime.now().isoformat()
    if artifacts is not None:
        stage_state["artifacts"] = artifacts


def _persist_state(state_path, state, args, output_dir, artifacts, stems):
    with _state_lock:
        state["source_file"] = str(Path(args.input).resolve())
        state["source_mtime"] = _safe_get_mtime(args.input)
        state["output_dir"] = output_dir
        state["fast_mode"] = bool(args.fast)
        state["mock_mode"] = bool(args.mock)
        state["selected_stage"] = args.stage
        state["artifacts"] = artifacts
        state["stems"] = stems if isinstance(stems, dict) else {}
        state["output_payload"] = args.output
        state["updated_at"] = datetime.now().isoformat()
        _write_json_file(state_path, state)


def _has_transcription_payload(path):
    payload = _read_json_file(path)
    return isinstance(payload, dict) and isinstance(payload.get("segments"), list)


def _has_semantics_payload(path):
    payload = _read_json_file(path)
    return isinstance(payload, list)


def validate_stage_artifacts(stage_name: str, output_dir: str) -> bool:
    """Return True if the given stage's output artifacts exist and are structurally valid."""
    out = Path(output_dir)
    try:
        if stage_name == "separation":
            stems_path = str(out / "data" / "stems.json")
            stems = _read_json_file(stems_path)
            if not isinstance(stems, dict):
                return False
            normalize_and_validate_stems(stems)
            return True

        if stage_name == "transcription":
            return _has_transcription_payload(str(out / "data" / "transcription.json"))

        if stage_name == "dsp":
            dsp_metrics_path = str(out / "data" / "dsp_metrics.json")
            metrics = _read_json_file(dsp_metrics_path, default={})
            if isinstance(metrics, dict) and bool(metrics):
                return True
            stage_state = _read_json_file(str(out / "data" / "stage_state.json"), default={})
            stages = stage_state.get("stages") if isinstance(stage_state, dict) else {}
            dsp_state = stages.get("dsp") if isinstance(stages, dict) else {}
            return isinstance(dsp_state, dict) and bool(
                dsp_state.get("completed") or dsp_state.get("is_complete")
            )

        if stage_name == "semantics":
            return _has_semantics_payload(str(out / "data" / "semantics.json"))

        if stage_name == "director":
            payload_path = str(out / "mikup_payload.json")
            payload = _read_json_file(payload_path)
            return isinstance(payload, dict) and bool(payload)

        return False
    except Exception as exc:
        logger.warning("validate_stage_artifacts(%s): unexpected error: %s", stage_name, exc)
        return False


def _write_silent_wav(path, duration_seconds=3.0, sample_rate=22050, channels=2):
    MikupSeparator._write_silent_wav(
        path=path,
        duration_seconds=duration_seconds,
        sample_rate=sample_rate,
        channels=channels,
    )


def _mock_stems(output_dir, source_hint="mock"):
    base_name = Path(source_hint).stem or "mock"
    out = Path(output_dir)
    stems = {
        "DX": str(out / f"{base_name}_DX.wav"),
        "Music": str(out / f"{base_name}_Music.wav"),
        "Effects": str(out / f"{base_name}_Effects.wav"),
        "DX_Residual": str(out / f"{base_name}_DX_Residual.wav"),
    }
    for stem_path in stems.values():
        if not is_existing_file(stem_path):
            _write_silent_wav(stem_path)
    return stems


def normalize_and_validate_stems(stems):
    normalized = _extract_canonical_stems(stems)
    if not normalized:
        raise ValueError("Separator returned invalid stems payload.")

    if not is_existing_file(normalized.get("DX")):
        raise FileNotFoundError("Stage 1 missing required stem file: DX")

    if not any(
        is_existing_file(normalized.get(key))
        for key in ("Effects", "Music")
    ):
        raise FileNotFoundError(
            "Stage 1 missing required background stem (Effects or Music)."
        )

    for key in CANONICAL_STEM_KEYS + OPTIONAL_STEM_KEYS:
        stem_path = normalized.get(key)
        if stem_path and not Path(stem_path).exists():
            logger.warning(
                "Stem %s not found at %s; continuing without it.",
                key,
                stem_path,
            )
            normalized[key] = None

    return normalized


def select_semantics_source_stem(stems):
    if not isinstance(stems, dict):
        return None
    for key in ("Effects", "Music"):
        path = stems.get(key)
        if is_existing_file(path):
            return path
    return None


def merge_dicts(base, override):
    if not isinstance(base, dict):
        base = {}
    if not isinstance(override, dict):
        return base

    merged = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = merge_dicts(merged[key], value)
        else:
            merged[key] = value
    return merged


def _resolve_source_file(args, stage_state):
    candidate = str(getattr(args, "input", "") or "").strip()
    if candidate and Path(candidate).name.lower() != "dummy":
        return candidate

    if isinstance(stage_state, dict):
        previous = str(stage_state.get("source_file") or "").strip()
        if previous and Path(previous).name.lower() != "dummy":
            return previous

    return candidate or "Unknown"


def _collect_stage_timestamps(stage_state):
    if not isinstance(stage_state, dict):
        return {}

    stages = stage_state.get("stages")
    if not isinstance(stages, dict):
        return {}

    stage_timestamps = {}
    for stage_name in STAGE_CHOICES:
        stage_entry = stages.get(stage_name)
        if not isinstance(stage_entry, dict):
            continue
        timestamp = stage_entry.get("timestamp")
        if isinstance(timestamp, str) and timestamp.strip():
            stage_timestamps[stage_name] = timestamp

    return stage_timestamps


def _load_transcription_data(path):
    data = _read_json_file(path, default={"segments": []})
    return data if isinstance(data, dict) else {"segments": []}


def _load_semantic_tags(path):
    loaded = _read_json_file(path, default=[])
    return loaded if isinstance(loaded, list) else []


def _load_dsp_metrics(path):
    data = _read_json_file(path, default={})
    return data if isinstance(data, dict) else {}


def _collect_existing_stem_paths(stems):
    if not isinstance(stems, dict):
        return []
    return [p for p in stems.values() if is_existing_file(p)]


def _check_missing_artifacts(stem_paths, transcription_path, dsp_metrics_path, semantics_path, stage_state_path):
    missing = []
    if not stem_paths:
        missing.append("stems")
    if not _has_transcription_payload(transcription_path):
        missing.append("transcription")
    if not is_existing_file(dsp_metrics_path):
        missing.append("dsp_metrics")
    if not _has_semantics_payload(semantics_path):
        missing.append("semantics")
    if not is_existing_file(stage_state_path):
        missing.append("stage_state")
    return missing


def _build_final_payload(args, output_dir, artifacts, stems, stage_state, ai_report=None):
    transcription_path = artifacts["transcription"]
    semantics_path = artifacts["semantics"]
    dsp_metrics_path = artifacts["dsp_metrics"]

    transcription_data = _load_transcription_data(transcription_path)
    semantic_tags = _load_semantic_tags(semantics_path)
    dsp_metrics = _load_dsp_metrics(dsp_metrics_path)
    generated_stem_paths = _collect_existing_stem_paths(stems)

    missing_artifacts = _check_missing_artifacts(
        generated_stem_paths, transcription_path, dsp_metrics_path, semantics_path, artifacts.get("stage_state"),
    )
    is_complete = len(missing_artifacts) == 0
    if not is_complete:
        logger.warning(
            "Final payload is partial; missing or invalid artifact(s): %s",
            ", ".join(missing_artifacts),
        )

    payload = {
        "is_complete": is_complete,
        "metadata": {
            "source_file": _resolve_source_file(args, stage_state),
            "pipeline_version": "0.2.0-beta",
            "timestamp": datetime.now().isoformat(),
            "is_complete": is_complete,
            "stage_timestamps": _collect_stage_timestamps(stage_state),
        },
        "transcription": transcription_data,
        "metrics": dsp_metrics,
        "semantics": {
            "background_tags": semantic_tags,
        },
        "artifacts": {
            "stem_paths": generated_stem_paths,
            "output_dir": output_dir,
            "stage_state": artifacts["stage_state"],
            "stems": artifacts["stems"],
            "transcription": transcription_path,
            "semantics": semantics_path,
            "dsp_metrics": dsp_metrics_path,
        },
    }

    payload["metrics"]["pacing_mikups"] = transcription_data.get("pacing_mikups", [])

    if isinstance(ai_report, str) and ai_report.strip():
        payload["ai_report"] = ai_report

    return payload


def _safe_get_mtime(path):
    if not is_existing_file(path):
        return None
    try:
        return Path(path).stat().st_mtime
    except OSError:
        return None


def _read_config(config_path=None):
    """Read data/config.json and return its contents as a dict."""
    if config_path is None:
        config_path = PROJECT_ROOT / "data" / "config.json"
    return _read_json_file(str(Path(config_path).resolve()), default={}) or {}


def _resolve_output_dir(input_path, output_dir_flag=None, config_path=None):
    """
    Determine the output workspace directory.

    - If output_dir_flag is given (user passed --output-dir), use it verbatim as abspath.
    - Otherwise, generate a collision-safe timestamped workspace:
        <default_projects_dir>/<input_stem>_<YYYYMMDD_HHMMSS>_<pid>/
      where default_projects_dir comes from data/config.json, falling back to
      <repo_root>/Projects/.
    """
    if output_dir_flag is not None:
        return str(Path(output_dir_flag).resolve())

    config = _read_config(config_path)
    base = config.get("default_projects_dir") or str(PROJECT_ROOT / "Projects")
    stem = Path(input_path).stem or "project"
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    short_id = uuid.uuid4().hex[:8]
    return str(Path(base).resolve() / f"{stem}_{timestamp}_{short_id}")


def _timestamps_match(lhs, rhs, tolerance=1e-6):
    if lhs is None or rhs is None:
        return False
    return abs(float(lhs) - float(rhs)) <= tolerance


def _artifacts_match_source_timestamp(artifacts, source_mtime):
    if source_mtime is None:
        return False
    checked = 0
    for artifact_path in artifacts.values():
        if not is_existing_file(artifact_path):
            continue
        artifact_mtime = _safe_get_mtime(artifact_path)
        if artifact_mtime is None:
            return False
        if artifact_mtime + 1e-6 < source_mtime:
            return False
        checked += 1
    if checked == 0:
        return False
    return True


def _is_history_snapshot_safe(args, stage_state, artifacts):
    requested_stage = getattr(args, "stage", None)
    if not requested_stage:
        return True

    source_file = str(Path(getattr(args, "input", "") or "").resolve())
    current_source_mtime = _safe_get_mtime(source_file)
    recorded_source_file = str(Path(str(stage_state.get("source_file") or "")).resolve())
    recorded_source_mtime = stage_state.get("source_mtime")
    stage_artifacts = stage_state.get("artifacts") if isinstance(stage_state, dict) else {}
    if not isinstance(stage_artifacts, dict):
        stage_artifacts = artifacts

    if recorded_source_file != source_file:
        return False

    if current_source_mtime is None:
        # Mock/dummy sources may not exist on disk. If the snapshot has a recorded mtime
        # the file has since disappeared -- treat as unsafe. If both are None, path identity
        # (already confirmed above) is the only available guard.
        if recorded_source_mtime is not None:
            return False
        return True

    if not _timestamps_match(recorded_source_mtime, current_source_mtime):
        return False

    return _artifacts_match_source_timestamp(stage_artifacts, current_source_mtime)


def _update_history_snapshot(args, output_dir, artifacts, stems, stage_state, ai_report=None):
    if not _is_history_snapshot_safe(args, stage_state, artifacts):
        logger.warning(
            "Skipped history snapshot update for stage '%s': cached artifacts do not match source file timestamp.",
            args.stage,
        )
        return None

    snapshot_payload = _build_final_payload(
        args=args,
        output_dir=output_dir,
        artifacts=artifacts,
        stems=stems,
        stage_state=stage_state,
        ai_report=ai_report,
    )
    try:
        update_history(snapshot_payload)
    except OSError as exc:
        logger.error("Failed to update history file: %s", exc)
    return snapshot_payload


def _relativize_path(path, root):
    if not isinstance(path, (str, Path)) or (isinstance(path, str) and not path.strip()):
        return path
    p = Path(path)
    if not p.is_absolute():
        return str(p)
    try:
        return str(p.relative_to(root))
    except ValueError:
        return str(p)


def _relativize_payload_paths(payload, root):
    if not isinstance(payload, dict):
        return payload
    artifacts = payload.get("artifacts")
    if not isinstance(artifacts, dict):
        return payload

    stem_paths = artifacts.get("stem_paths")
    if isinstance(stem_paths, list):
        artifacts["stem_paths"] = [_relativize_path(path, root) for path in stem_paths]

    return payload


def update_history(payload, history_path="data/history.json"):
    """Adds the current analysis to the history.json file."""
    with _state_lock:
        history = []
        hp = Path(history_path)
        if hp.exists():
            try:
                with open(hp, "r", encoding="utf-8") as f:
                    history = json.load(f)
            except (OSError, json.JSONDecodeError):
                history = []

        metadata = payload.get("metadata") or {}
        metrics = payload.get("metrics") or {}
        spatial_metrics = (metrics.get("spatial_metrics") or {})
        artifacts = payload.get("artifacts") or {}
        source_file = str(metadata.get("source_file", "")) or "Unknown"

        entry = {
            "id": str(uuid.uuid4()),
            "filename": Path(source_file).name or "Unknown",
            "date": datetime.now().isoformat(),
            "duration": spatial_metrics.get("total_duration", 0) or 0,
            "is_complete": bool(payload.get("is_complete")),
            "output_dir": _relativize_path(artifacts.get("output_dir", ""), project_root),
            "pipeline_version": metadata.get("pipeline_version", "unknown"),
        }

        history.insert(0, entry)
        # Keep last 50 projects
        history = history[:50]

        history_dir = hp.parent
        if str(history_dir) and str(history_dir) != ".":
            history_dir.mkdir(parents=True, exist_ok=True)
        with open(hp, "w", encoding="utf-8") as f:
            json.dump(history, f, indent=2)


def cleanup_stems(stems):
    """Deletes processed WAV stems to save space."""
    for path in stems.values():
        if path and Path(path).exists():
            try:
                Path(path).unlink()
                logger.info("Cleaned up stem: %s", path)
            except OSError as e:
                logger.warning("Failed to cleanup stem %s: %s", path, e)


def _as_dict(value):
    return value if isinstance(value, dict) else {}


def _safe_float(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _format_metric(value, decimals=2):
    number = _safe_float(value)
    if number is None:
        return "N/A"
    return f"{number:.{decimals}f}"


def build_mikup_context_markdown(payload):
    metadata = _as_dict(payload.get("metadata"))
    metrics = _as_dict(payload.get("metrics"))
    spatial_metrics = _as_dict(metrics.get("spatial_metrics"))
    lufs_graph = _as_dict(metrics.get("lufs_graph"))
    dialogue_lufs = _as_dict(lufs_graph.get("DX") or lufs_graph.get("dialogue_raw"))
    diagnostic_meters = _as_dict(metrics.get("diagnostic_meters"))
    semantics = _as_dict(payload.get("semantics"))

    source_path = metadata.get("source_file", "unknown")
    source_file = Path(str(source_path)).name or "unknown"
    timestamp = str(metadata.get("timestamp") or datetime.now().isoformat())
    duration_seconds = _safe_float(spatial_metrics.get("total_duration"))

    duration_label = f"{duration_seconds:.2f}s" if duration_seconds is not None else "N/A"

    lines = [
        f"# Mikup Context Bridge: {source_file}",
        "",
        "## Metadata",
        f"- Filename: {source_file}",
        f"- Timestamp: {timestamp}",
        f"- Total Duration: {duration_label}",
        "",
        "## DSP Summary",
        f"- Integrated LUFS (DX): {_format_metric(dialogue_lufs.get('integrated'), 2)}",
        f"- Average Phase Correlation: {_format_metric(diagnostic_meters.get('stereo_correlation'), 3)}",
        f"- Stereo Balance: {_format_metric(diagnostic_meters.get('stereo_balance'), 3)}",
        "",
        "## Semantic Tags (CLAP)",
    ]

    background_tags = semantics.get("background_tags")
    if isinstance(background_tags, list) and background_tags:
        for tag in background_tags:
            if not isinstance(tag, dict):
                continue
            label = str(tag.get("label", "Unknown"))
            score = _safe_float(tag.get("score"))
            if score is None:
                lines.append(f"- {label}")
            else:
                lines.append(f"- {label} ({score * 100:.0f}%)")
    else:
        lines.append("- None detected.")

    lines.extend(["", "## Events (First 15 Pacing Intervals)"])
    pacing_mikups = metrics.get("pacing_mikups")
    parsed_events = []
    if isinstance(pacing_mikups, list):
        for index, event in enumerate(pacing_mikups[:15], start=1):
            if not isinstance(event, dict):
                continue
            timestamp_s = _safe_float(event.get("timestamp", event.get("start")))
            duration_ms = _safe_float(event.get("duration_ms"))
            start_s = _safe_float(event.get("start"))
            end_s = _safe_float(event.get("end"))
            duration_s = (
                duration_ms / 1000.0
                if duration_ms is not None
                else end_s - start_s
                if end_s is not None and start_s is not None
                else None
            )
            if timestamp_s is None or duration_s is None:
                continue
            context = event.get("context")
            context_text = f" | {context}" if isinstance(context, str) and context.strip() else ""
            parsed_events.append(
                f"- {index:02d}. {timestamp_s:.2f}s | gap {duration_s:.2f}s{context_text}"
            )

    if parsed_events:
        lines.extend(parsed_events)
    else:
        lines.append("- No events detected.")

    ai_report = payload.get("ai_report")
    if isinstance(ai_report, str) and ai_report.strip():
        lines.extend([
            "",
            "## AI Director Report",
            ai_report.strip(),
        ])

    lines.append("")
    return "\n".join(lines)


def write_mikup_context_file(payload, output_dir):
    with _state_lock:
        context_path = Path(output_dir) / "data" / ".mikup_context.md"
        context_markdown = build_mikup_context_markdown(payload)
        ensure_output_dir(str(context_path))
        with open(context_path, "w", encoding="utf-8") as f:
            f.write(context_markdown)
        logger.info("LLM Context bridge generated: %s", context_path)


def main():
    parser = argparse.ArgumentParser(description="Project Mikup - Audio Drama Deconstruction Pipeline")
    parser.add_argument("--input", type=str, help="Path to raw audio file", required=True)
    parser.add_argument("--output", type=str, help="Path to output Mikup JSON/Report", default=None)
    parser.add_argument("--output-dir", type=str,
        help="Directory for intermediate stage artifacts (default: auto-generated Projects workspace)",
        default=None)
    parser.add_argument("--stage", choices=STAGE_CHOICES, help="Run only the specified stage and exit")
    parser.add_argument("--redo-stage", type=_parse_redo_stage, choices=REDO_STAGE_CHOICES,
        help="Redo the specified stage and invalidate all downstream stage artifacts")
    parser.add_argument("--fast", action=argparse.BooleanOptionalAction, default=None,
        help="Quick mode: skip heavy separation/transcription work")
    parser.add_argument("--mock", action=argparse.BooleanOptionalAction, default=None,
        help="Use mock data for testing")
    parser.add_argument("--force", action="store_true", help="Force re-run of stage(s) even if artifacts exist")

    args = parser.parse_args()
    args.input = str(Path(args.input).resolve())

    output_dir = _resolve_output_dir(
        input_path=args.input,
        output_dir_flag=args.output_dir,
    )
    args.output_dir = output_dir
    args.output = args.output or str(Path(output_dir) / "mikup_payload.json")

    try:
        ensure_directory(output_dir)
        ensure_output_dir(args.output)
    except OSError as exc:
        logger.error("Unable to create output directory for artifacts/output: %s", exc)
        sys.exit(1)

    artifacts = _artifact_paths(output_dir)
    manual_workflow = args.stage is not None
    full_pipeline = not manual_workflow

    emit_progress("INIT", 0, "Initializing Project Mikup Pipeline...")

    stage_state = _read_json_file(artifacts["stage_state"], default={})
    if not isinstance(stage_state, dict):
        stage_state = {}

    if args.fast is None:
        args.fast = bool(stage_state.get("fast_mode", False))
    if args.mock is None:
        args.mock = bool(stage_state.get("mock_mode", False))

    if not Path(args.input).exists() and not args.mock:
        logger.error("Input file %s not found.", args.input)
        sys.exit(1)

    previous_source = stage_state.get("source_file")
    if (
        previous_source
        and not args.mock
        and str(Path(previous_source).resolve()) != str(Path(args.input).resolve())
        and full_pipeline
    ):
        logger.warning(
            "Existing stage_state.json is for %s, but current input is %s. Starting full pipeline stages fresh.",
            previous_source,
            str(Path(args.input).resolve()),
        )
        stage_state = {}

    forced_stages = _invalidate_redo_stages(args, output_dir, artifacts, stage_state)
    if forced_stages:
        args.force = True
        _write_json_file(artifacts["stage_state"], stage_state)

    def _allow_cache(stage_name):
        return not args.force or stage_name not in forced_stages

    stems = _read_json_file(artifacts["stems"], default={})
    if not isinstance(stems, dict):
        stems = {}

    transcription_path = artifacts["transcription"]
    semantics_path = artifacts["semantics"]

    has_separation = validate_stage_artifacts("separation", output_dir) and _allow_cache("separation")
    should_run_separation = (args.stage == "separation") or (full_pipeline and not has_separation)

    validated_stems = None
    if not should_run_separation:
        try:
            validated_stems = normalize_and_validate_stems(stems)
        except (FileNotFoundError, ValueError):
            validated_stems = None

    if should_run_separation:
        if args.mock:
            emit_progress("SEPARATION", 10, "Mock separation stage initialized...")
            try:
                stems = _mock_stems(output_dir, args.input)
            except OSError as exc:
                logger.error("Stage 1 Separation failed: %s", exc)
                sys.exit(1)
            emit_progress("SEPARATION", 25, "Mock separation artifacts registered.")
        else:
            emit_progress("SEPARATION", 10, "Cinematic 3-Pass Separation starting...")
            separator = MikupSeparator(output_dir=str(Path(output_dir) / "stems"))
            try:
                stems = normalize_and_validate_stems(
                    separator.run_surgical_pipeline(args.input, fast_mode=args.fast)
                )
                emit_progress("SEPARATION", 25, "Separation complete.")
            except (FileNotFoundError, OSError, RuntimeError, ValueError) as exc:
                logger.error("Stage 1 Separation failed: %s", exc)
                sys.exit(1)
            finally:
                del separator
                flush_vram()
                gc.collect()

        _write_json_file(artifacts["stems"], stems)
        _mark_stage_complete(stage_state, "separation", {"stems": artifacts["stems"]})
        _persist_state(artifacts["stage_state"], stage_state, args, output_dir, artifacts, stems)
        _update_history_snapshot(args, output_dir, artifacts, stems, stage_state)
        gc.collect()
    elif validated_stems is not None:
        stems = validated_stems
        if full_pipeline:
            emit_progress("SEPARATION", 25, "Using existing separation artifacts from output-dir.")
    else:
        logger.error(
            "Stage '%s' requires existing stems in %s. Run --stage separation first.",
            args.stage,
            artifacts["stems"],
        )
        sys.exit(1)

    if args.stage == "separation":
        if not should_run_separation:
            _update_history_snapshot(args, output_dir, artifacts, stems, stage_state)
        emit_progress("COMPLETE", 100, "Requested stage finished.")
        return

    has_transcription = validate_stage_artifacts("transcription", output_dir) and _allow_cache("transcription")
    should_run_transcription = (args.stage == "transcription") or (full_pipeline and not has_transcription)

    if should_run_transcription:
        emit_progress("TRANSCRIPTION", 30, "Transcription & Diarization starting...")
        if args.mock:
            write_empty_transcription(transcription_path)
            emit_progress("TRANSCRIPTION", 50, "Mock transcription artifact written.")
        elif is_existing_file(stems.get("DX")):
            transcriber = MikupTranscriber()
            try:
                transcription_result = transcriber.transcribe(
                    stems["DX"],
                    fast_mode=args.fast,
                )
                if args.fast:
                    logger.info("Fast mode enabled: skipping diarization step.")
                else:
                    transcription_result = transcriber.diarize(
                        stems["DX"],
                        transcription_result,
                        os.getenv("HF_TOKEN"),
                    )

                transcriber.save_results(transcription_result, transcription_path)
                emit_progress("TRANSCRIPTION", 50, "Transcription complete.")
            except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as exc:
                logger.error("Stage 2 Transcription failed: %s", exc)
                try:
                    write_empty_transcription(transcription_path)
                except OSError as write_exc:
                    logger.error("Failed to write fallback transcription file: %s", write_exc)
                    sys.exit(1)
            finally:
                del transcriber
                flush_vram()
                gc.collect()
        else:
            logger.warning("No valid dialogue stem found. Writing empty transcription artifact.")
            try:
                write_empty_transcription(transcription_path)
            except OSError as exc:
                logger.error("Failed to write empty transcription file: %s", exc)
                sys.exit(1)

        _mark_stage_complete(stage_state, "transcription", {"transcription": transcription_path})
        _persist_state(artifacts["stage_state"], stage_state, args, output_dir, artifacts, stems)
        _update_history_snapshot(args, output_dir, artifacts, stems, stage_state)
        gc.collect()
    elif has_transcription:
        if full_pipeline:
            emit_progress("TRANSCRIPTION", 50, "Using existing transcription artifact from output-dir.")
    else:
        if args.stage in {"dsp", "semantics", "director"}:
            logger.error(
                "Stage '%s' requires existing transcription artifact in %s. Run --stage transcription first.",
                args.stage,
                transcription_path,
            )
            sys.exit(1)

    if args.stage == "transcription":
        if not should_run_transcription:
            _update_history_snapshot(args, output_dir, artifacts, stems, stage_state)
        emit_progress("COMPLETE", 100, "Requested stage finished.")
        return

    has_dsp_metrics = validate_stage_artifacts("dsp", output_dir) and _allow_cache("dsp")
    should_run_dsp = (args.stage == "dsp") or (full_pipeline and not has_dsp_metrics)

    if should_run_dsp:
        emit_progress("DSP", 60, "Feature Extraction (Handled by Rust Backend)")

        # The DSP logic has been migrated to the native Rust engine (native/src/dsp/)
        # for real-time 60fps streaming and perfect DAW-level audio synchronization.
        # When called from this CLI, we simply acknowledge the stage and skip it.
        emit_progress("DSP", 75, "Rust handles DSP. Skipping in Python CLI.")

        dsp_artifacts = {}
        if is_existing_file(artifacts["dsp_metrics"]):
            dsp_artifacts["dsp_metrics"] = artifacts["dsp_metrics"]
        _mark_stage_complete(stage_state, "dsp", dsp_artifacts or None)
        _persist_state(artifacts["stage_state"], stage_state, args, output_dir, artifacts, stems)
        _update_history_snapshot(args, output_dir, artifacts, stems, stage_state)
        gc.collect()
    elif has_dsp_metrics and full_pipeline:
        emit_progress("DSP", 75, "Using existing DSP artifact from output-dir.")

    if args.stage == "dsp":
        if not should_run_dsp:
            _update_history_snapshot(args, output_dir, artifacts, stems, stage_state)
        emit_progress("COMPLETE", 100, "Requested stage finished.")
        return

    has_semantics = validate_stage_artifacts("semantics", output_dir) and _allow_cache("semantics")
    should_run_semantics = (args.stage == "semantics") or (full_pipeline and not has_semantics)

    semantic_tags = []
    if should_run_semantics:
        if args.mock:
            semantic_tags = []
            _write_json_file(semantics_path, semantic_tags)
        elif select_semantics_source_stem(stems):
            emit_progress("SEMANTICS", 80, "Semantic Tagging (CLAP) starting...")
            tagger = None
            try:
                semantics_stem = select_semantics_source_stem(stems)
                tagger = MikupSemanticTagger()
                semantic_tags = tagger.tag_audio(semantics_stem)
                _write_json_file(semantics_path, semantic_tags)
                emit_progress("SEMANTICS", 85, "Semantics complete.")
            except (OSError, RuntimeError, ValueError, AttributeError) as exc:
                logger.error("Stage 4 Semantic Tagging failed: %s", exc)
                semantic_tags = []
                _write_json_file(semantics_path, semantic_tags)
            finally:
                if tagger is not None:
                    del tagger
                flush_vram()
                gc.collect()
        else:
            logger.warning("No valid background stem found. Writing empty semantics artifact.")
            semantic_tags = []
            _write_json_file(semantics_path, semantic_tags)

        _mark_stage_complete(stage_state, "semantics", {"semantics": semantics_path})
        _persist_state(artifacts["stage_state"], stage_state, args, output_dir, artifacts, stems)
        _update_history_snapshot(args, output_dir, artifacts, stems, stage_state)
        gc.collect()
    elif full_pipeline:
        loaded_semantics = _read_json_file(semantics_path, default=[])
        semantic_tags = loaded_semantics if isinstance(loaded_semantics, list) else []
        emit_progress("SEMANTICS", 85, "Using existing semantics artifact from output-dir.")

    if args.stage == "semantics":
        if not should_run_semantics:
            _update_history_snapshot(args, output_dir, artifacts, stems, stage_state)
        emit_progress("COMPLETE", 100, "Requested stage finished.")
        return

    final_payload = _build_final_payload(
        args=args,
        output_dir=output_dir,
        artifacts=artifacts,
        stems=stems,
        stage_state=stage_state,
    )

    if args.stage == "director" or full_pipeline:
        if args.mock:
            pass
        else:
            emit_progress("DIRECTOR", 90, "AI Director (Gemini 2.0) synthesis starting...")
            director = None
            try:
                director = MikupDirector(
                    payload_path=args.output,
                    workspace_dir=output_dir,
                )
                report_md = director.generate_report(final_payload)
                if report_md:
                    final_payload["ai_report"] = report_md
                    report_path = str(Path(output_dir) / "mikup_report.md")
                    try:
                        with open(report_path, "w", encoding="utf-8") as f:
                            f.write(report_md)
                        logger.info("AI Director report saved to: %s", report_path)
                    except OSError as exc:
                        logger.error("Failed to save AI Director markdown report: %s", exc)
                else:
                    logger.warning("AI Director returned no usable report. Skipping ai_report field.")
                emit_progress("DIRECTOR", 95, "Synthesis complete.")
            except Exception as exc:
                logger.error("Stage 5 AI Director failed: %s", exc)
            finally:
                if director is not None:
                    del director
                flush_vram()
                gc.collect()

        try:
            with open(args.output, "w", encoding="utf-8") as f:
                json.dump(final_payload, f, indent=2)
            logger.info("Pipeline complete. Payload saved to: %s", args.output)

            try:
                write_mikup_context_file(final_payload, output_dir)
            except OSError as exc:
                logger.error("Failed to generate context bridge file: %s", exc)

            _mark_stage_complete(stage_state, "director", {"output": args.output})
            _persist_state(artifacts["stage_state"], stage_state, args, output_dir, artifacts, stems)
            _update_history_snapshot(
                args,
                output_dir,
                artifacts,
                stems,
                stage_state,
                ai_report=final_payload.get("ai_report"),
            )

            emit_progress("COMPLETE", 100, "All stages finished. Results archived.")
        except OSError as exc:
            logger.error("Failed to save final payload: %s", exc)
            sys.exit(1)


if __name__ == "__main__":
    main()
