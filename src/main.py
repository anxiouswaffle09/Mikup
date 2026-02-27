import os
import argparse
import json
import gc
import sys
import uuid
import torch
import logging
import time
import math
from datetime import datetime
from dotenv import load_dotenv

logging.basicConfig(level=logging.INFO, format='%(message)s')
logger = logging.getLogger(__name__)

# Allow running as either `python src/main.py` or `python -m src.main`.
project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if __package__ in (None, ""):
    if project_root not in sys.path:
        sys.path.insert(0, project_root)

from src.ingestion.separator import MikupSeparator
from src.transcription.transcriber import MikupTranscriber
from src.dsp.processor import MikupDSPProcessor
from src.semantics.tagger import MikupSemanticTagger
from src.llm.director import MikupDirector

# Load environment variables
load_dotenv()

STAGE_CHOICES = ("separation", "transcription", "dsp", "semantics", "director")


def flush_vram():
    """Forcefully clear VRAM and RAM cache."""
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        pass


def emit_progress(stage, progress, message):
    """Emit a JSON progress marker to stdout for Tauri to capture."""
    print(json.dumps({
        "type": "progress",
        "stage": stage,
        "progress": progress,
        "message": message,
        "timestamp": time.time()
    }), flush=True)


def is_existing_file(path):
    return isinstance(path, str) and bool(path.strip()) and os.path.exists(path)


def ensure_directory(path):
    os.makedirs(path, exist_ok=True)
    return path


def ensure_output_dir(output_path):
    output_dir = os.path.dirname(output_path) or "."
    os.makedirs(output_dir, exist_ok=True)
    return output_dir


def write_empty_transcription(path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"segments": []}, f)


def _read_json_file(path, default=None):
    if not is_existing_file(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("Failed to read JSON from %s: %s", path, exc)
        return default


def _write_json_file(path, payload):
    ensure_output_dir(path)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)


def _artifact_paths(output_dir):
    return {
        "stage_state": os.path.join(output_dir, "stage_state.json"),
        "stems": os.path.join(output_dir, "stems.json"),
        "transcription": os.path.join(output_dir, "transcription.json"),
        "dsp_metrics": os.path.join(output_dir, "dsp_metrics.json"),
        "semantics": os.path.join(output_dir, "semantics.json"),
    }


def _mark_stage_complete(state, stage_name, artifacts=None):
    stages = state.setdefault("stages", {})
    stage_state = stages.setdefault(stage_name, {})
    stage_state["completed"] = True
    stage_state["timestamp"] = datetime.now().isoformat()
    if artifacts is not None:
        stage_state["artifacts"] = artifacts


def _persist_state(state_path, state, args, output_dir, artifacts, stems):
    state["source_file"] = os.path.abspath(args.input)
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


def _has_dsp_payload(path):
    payload = _read_json_file(path)
    return isinstance(payload, dict) and bool(payload)


def _has_semantics_payload(path):
    payload = _read_json_file(path)
    return isinstance(payload, list)


def validate_stage_artifacts(stage_name: str, output_dir: str) -> bool:
    """Return True if the given stage's output artifacts exist and are structurally valid."""
    try:
        if stage_name == "separation":
            stems_path = os.path.join(output_dir, "stems.json")
            stems = _read_json_file(stems_path)
            if not isinstance(stems, dict):
                return False
            for key in ("dialogue_raw", "background_raw"):
                if not is_existing_file(stems.get(key)):
                    return False
            return True

        if stage_name == "transcription":
            return _has_transcription_payload(os.path.join(output_dir, "transcription.json"))

        if stage_name == "dsp":
            return _has_dsp_payload(os.path.join(output_dir, "dsp_metrics.json"))

        if stage_name == "semantics":
            return _has_semantics_payload(os.path.join(output_dir, "semantics.json"))

        if stage_name == "director":
            path = os.path.join(output_dir, "mikup_payload.json")
            payload = _read_json_file(path)
            return isinstance(payload, dict) and bool(payload)

        return False
    except Exception as exc:
        logger.warning("validate_stage_artifacts(%s): unexpected error: %s", stage_name, exc)
        return False


def _mock_stems():
    processed_dir = os.path.join(project_root, "data", "processed")
    return {
        "dialogue_raw": os.path.join(processed_dir, "test_Vocals.wav"),
        "background_raw": os.path.join(processed_dir, "test_Instrumental.wav"),
        "dialogue_dry": os.path.join(processed_dir, "test_Dry_Vocals.wav"),
        "reverb_tail": os.path.join(processed_dir, "test_Reverb.wav"),
    }


def normalize_and_validate_stems(stems):
    if not isinstance(stems, dict):
        raise ValueError("Separator returned invalid stems payload.")

    normalized = {}
    for key in ("dialogue_raw", "background_raw", "dialogue_dry", "reverb_tail"):
        value = stems.get(key)
        normalized[key] = value if isinstance(value, str) and value.strip() else None

    missing_required = [
        key for key in ("dialogue_raw", "background_raw")
        if not is_existing_file(normalized.get(key))
    ]
    if missing_required:
        raise FileNotFoundError(
            f"Stage 1 missing required stem files: {', '.join(missing_required)}"
        )

    for key in ("dialogue_dry", "reverb_tail"):
        stem_path = normalized.get(key)
        if stem_path and not os.path.exists(stem_path):
            logger.warning(
                "Optional stem %s not found at %s; continuing without it.",
                key,
                stem_path,
            )
            normalized[key] = None

    return normalized


def update_history(payload, history_path="data/history.json"):
    """Adds the current analysis to the history.json file."""
    history = []
    if os.path.exists(history_path):
        try:
            with open(history_path, "r", encoding="utf-8") as f:
                history = json.load(f)
        except (OSError, json.JSONDecodeError):
            history = []

    metadata = payload.get("metadata") or {}
    metrics = payload.get("metrics") or {}
    spatial_metrics = metrics.get("spatial_metrics") or {}
    source_file = str(metadata.get("source_file", "")) or "Unknown"

    # Create a summary entry
    entry = {
        "id": str(uuid.uuid4()),
        "filename": os.path.basename(source_file) or "Unknown",
        "date": datetime.now().isoformat(),
        "duration": spatial_metrics.get("total_duration", 0) or 0,
        "payload": payload  # Store full payload for instant loading
    }

    history.insert(0, entry)
    # Keep last 50 projects
    history = history[:50]

    history_dir = os.path.dirname(history_path)
    if history_dir:
        os.makedirs(history_dir, exist_ok=True)
    with open(history_path, "w", encoding="utf-8") as f:
        json.dump(history, f, indent=2)


def cleanup_stems(stems):
    """Deletes processed WAV stems to save space."""
    for path in stems.values():
        if path and os.path.exists(path):
            try:
                os.remove(path)
                logger.info(f"Cleaned up stem: {path}")
            except Exception as e:
                logger.warning(f"Failed to cleanup stem {path}: {e}")


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
    dialogue_lufs = _as_dict(lufs_graph.get("dialogue_raw"))
    diagnostic_meters = _as_dict(metrics.get("diagnostic_meters"))
    semantics = _as_dict(payload.get("semantics"))

    source_path = metadata.get("source_file", "unknown")
    source_file = os.path.basename(str(source_path)) or "unknown"
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
        f"- Integrated LUFS (dialogue_raw): {_format_metric(dialogue_lufs.get('integrated'), 2)}",
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

    lines.extend(["", "## Atomic Events (Pacing Mikups, first 15)"])
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
        lines.append("- No pacing events detected.")

    ai_report = payload.get("ai_report")
    if isinstance(ai_report, str) and ai_report.strip():
        lines.extend([
            "",
            "## AI Director Report",
            ai_report.strip(),
        ])

    lines.append("")
    return "\n".join(lines)


def write_mikup_context_file(payload):
    context_path = os.path.join(project_root, ".mikup_context.md")
    context_markdown = build_mikup_context_markdown(payload)
    with open(context_path, "w", encoding="utf-8") as f:
        f.write(context_markdown)
    logger.info("LLM Context bridge generated: %s", context_path)


def main():
    parser = argparse.ArgumentParser(description="Project Mikup - Audio Drama Deconstruction Pipeline")
    parser.add_argument("--input", type=str, help="Path to raw audio file", required=True)
    parser.add_argument("--output", type=str, help="Path to output Mikup JSON/Report", default=None)
    parser.add_argument("--output-dir", type=str, help="Directory for intermediate stage artifacts", default="data/processed")
    parser.add_argument("--stage", choices=STAGE_CHOICES, help="Run only the specified stage and exit")
    parser.add_argument("--fast", action="store_true", help="Quick mode: skip heavy separation/transcription work")
    parser.add_argument("--mock", action="store_true", help="Use mock data for testing")
    parser.add_argument("--force", action="store_true", help="Force re-run of stage(s) even if artifacts exist")

    args = parser.parse_args()
    args.input = os.path.abspath(args.input)
    args.output_dir = os.path.abspath(args.output_dir)

    if not os.path.exists(args.input) and not args.mock:
        logger.error(f"Input file {args.input} not found.")
        sys.exit(1)

    output_dir = args.output_dir
    args.output = args.output or os.path.join(output_dir, "mikup_payload.json")

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

    previous_source = stage_state.get("source_file")
    if (
        previous_source
        and not args.mock
        and os.path.abspath(previous_source) != os.path.abspath(args.input)
        and full_pipeline
    ):
        logger.warning(
            "Existing stage_state.json is for %s, but current input is %s. Starting full pipeline stages fresh.",
            previous_source,
            os.path.abspath(args.input),
        )
        stage_state = {}

    stems = _read_json_file(artifacts["stems"], default={})
    if not isinstance(stems, dict):
        stems = {}

    transcription_path = artifacts["transcription"]
    dsp_metrics_path = artifacts["dsp_metrics"]
    semantics_path = artifacts["semantics"]

    has_separation = validate_stage_artifacts("separation", output_dir) and not args.force
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
            stems = _mock_stems()
            emit_progress("SEPARATION", 25, "Mock separation artifacts registered.")
        else:
            emit_progress("SEPARATION", 10, "Surgical Separation (UVR5) starting...")
            separator = MikupSeparator(output_dir=output_dir)
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
        emit_progress("COMPLETE", 100, "Requested stage finished.")
        return

    has_transcription = validate_stage_artifacts("transcription", output_dir) and not args.force
    should_run_transcription = (args.stage == "transcription") or (full_pipeline and not has_transcription)

    if should_run_transcription:
        emit_progress("TRANSCRIPTION", 30, "Transcription & Diarization starting...")
        if args.mock:
            write_empty_transcription(transcription_path)
            emit_progress("TRANSCRIPTION", 50, "Mock transcription artifact written.")
        elif is_existing_file(stems.get("dialogue_raw")):
            transcriber = MikupTranscriber()
            try:
                transcription_result = transcriber.transcribe(
                    stems["dialogue_raw"],
                    fast_mode=args.fast,
                )
                if args.fast:
                    logger.info("Fast mode enabled: skipping diarization step.")
                else:
                    transcription_result = transcriber.diarize(
                        stems["dialogue_raw"],
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
        emit_progress("COMPLETE", 100, "Requested stage finished.")
        return

    has_dsp_metrics = validate_stage_artifacts("dsp", output_dir) and not args.force
    should_run_dsp = (args.stage == "dsp") or (full_pipeline and not has_dsp_metrics)

    if should_run_dsp:
        emit_progress("DSP", 60, "Feature Extraction (DSP/LUFS) starting...")
        processor = MikupDSPProcessor()
        try:
            dsp_metrics = processor.process_stems(stems, transcription_path)
            _write_json_file(dsp_metrics_path, dsp_metrics)
            emit_progress("DSP", 75, "DSP Analysis complete.")
        except (FileNotFoundError, OSError, RuntimeError, ValueError, json.JSONDecodeError) as exc:
            logger.error("Stage 3 DSP Processing failed: %s", exc)
            sys.exit(1)
        finally:
            del processor
            flush_vram()
            gc.collect()

        _mark_stage_complete(stage_state, "dsp", {"dsp_metrics": dsp_metrics_path})
        _persist_state(artifacts["stage_state"], stage_state, args, output_dir, artifacts, stems)
        gc.collect()
    elif has_dsp_metrics and full_pipeline:
        emit_progress("DSP", 75, "Using existing DSP artifact from output-dir.")

    if args.stage == "dsp":
        emit_progress("COMPLETE", 100, "Requested stage finished.")
        return

    has_semantics = validate_stage_artifacts("semantics", output_dir) and not args.force
    should_run_semantics = (args.stage == "semantics") or (full_pipeline and not has_semantics)

    semantic_tags = []
    if should_run_semantics:
        if args.mock:
            semantic_tags = []
            _write_json_file(semantics_path, semantic_tags)
        elif is_existing_file(stems.get("background_raw")):
            emit_progress("SEMANTICS", 80, "Semantic Tagging (CLAP) starting...")
            tagger = None
            try:
                tagger = MikupSemanticTagger()
                semantic_tags = tagger.tag_audio(stems["background_raw"])
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
        gc.collect()
    elif full_pipeline:
        loaded_semantics = _read_json_file(semantics_path, default=[])
        semantic_tags = loaded_semantics if isinstance(loaded_semantics, list) else []
        emit_progress("SEMANTICS", 85, "Using existing semantics artifact from output-dir.")

    if args.stage == "semantics":
        emit_progress("COMPLETE", 100, "Requested stage finished.")
        return

    transcription_data = _read_json_file(transcription_path, default={"segments": []})
    if not isinstance(transcription_data, dict):
        transcription_data = {"segments": []}

    dsp_metrics = _read_json_file(dsp_metrics_path, default={})
    if not isinstance(dsp_metrics, dict):
        dsp_metrics = {}

    loaded_semantics = _read_json_file(semantics_path, default=[])
    if isinstance(loaded_semantics, list):
        semantic_tags = loaded_semantics

    if args.stage == "director" and not dsp_metrics:
        logger.error(
            "Stage 'director' requires DSP metrics in %s. Run --stage dsp first.",
            dsp_metrics_path,
        )
        sys.exit(1)

    generated_stem_paths = [
        stem_path
        for stem_path in stems.values()
        if is_existing_file(stem_path)
    ]

    final_payload = {
        "metadata": {
            "source_file": args.input,
            "pipeline_version": "0.2.0-beta",
            "timestamp": datetime.now().isoformat()
        },
        "transcription": transcription_data,
        "metrics": dsp_metrics,
        "semantics": {
            "background_tags": semantic_tags
        },
        "artifacts": {
            "stem_paths": generated_stem_paths,
            "output_dir": output_dir,
            "stage_state": artifacts["stage_state"],
            "stems": artifacts["stems"],
            "transcription": transcription_path,
            "dsp_metrics": dsp_metrics_path,
            "semantics": semantics_path,
        },
    }

    if args.stage == "director" or full_pipeline:
        if args.mock:
            pass
        else:
            emit_progress("DIRECTOR", 90, "AI Director (Gemini 2.0) synthesis starting...")
            director = None
            try:
                director = MikupDirector()
                report_md = director.generate_report(final_payload)
                if report_md:
                    final_payload["ai_report"] = report_md
                    report_path = os.path.join(output_dir, "mikup_report.md")
                    try:
                        with open(report_path, "w", encoding="utf-8") as f:
                            f.write(report_md)
                        logger.info("AI Director report saved to: %s", report_path)
                    except OSError as exc:
                        logger.error("Failed to save AI Director markdown report: %s", exc)
                else:
                    logger.warning("AI Director returned no usable report. Skipping ai_report field.")
                emit_progress("DIRECTOR", 95, "Synthesis complete.")
            finally:
                if director is not None:
                    del director
                flush_vram()
                gc.collect()

        try:
            with open(args.output, "w", encoding="utf-8") as f:
                json.dump(final_payload, f, indent=2)
            logger.info("Pipeline complete. Payload saved to: %s", args.output)

            update_history(final_payload)

            try:
                write_mikup_context_file(final_payload)
            except OSError as exc:
                logger.error("Failed to generate context bridge file: %s", exc)

            if not args.mock and not manual_workflow:
                cleanup_stems(stems)

            _mark_stage_complete(stage_state, "director", {"output": args.output})
            _persist_state(artifacts["stage_state"], stage_state, args, output_dir, artifacts, stems)

            emit_progress("COMPLETE", 100, "All stages finished. Results archived.")
        except OSError as exc:
            logger.error("Failed to save final payload: %s", exc)
            sys.exit(1)


if __name__ == "__main__":
    main()
