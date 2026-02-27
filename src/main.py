import os
import argparse
import json
import gc
import sys
import uuid
import torch
import logging
import time
from datetime import datetime
from dotenv import load_dotenv

logging.basicConfig(level=logging.INFO, format='%(message)s')
logger = logging.getLogger(__name__)

# Allow running as either `python src/main.py` or `python -m src.main`.
if __package__ in (None, ""):
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if project_root not in sys.path:
        sys.path.insert(0, project_root)

from src.ingestion.separator import MikupSeparator
from src.transcription.transcriber import MikupTranscriber
from src.dsp.processor import MikupDSPProcessor
from src.semantics.tagger import MikupSemanticTagger
from src.llm.director import MikupDirector

# Load environment variables
load_dotenv()

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


def ensure_output_dir(output_path):
    output_dir = os.path.dirname(output_path) or "."
    os.makedirs(output_dir, exist_ok=True)
    return output_dir


def write_empty_transcription(path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"segments": []}, f)


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
    
    # Create a summary entry
    entry = {
        "id": str(uuid.uuid4()),
        "filename": os.path.basename(payload["metadata"]["source_file"]),
        "date": datetime.now().isoformat(),
        "duration": payload["metrics"]["spatial_metrics"].get("total_duration", 0),
        "payload": payload # Store full payload for instant loading
    }
    
    history.insert(0, entry)
    # Keep last 50 projects
    history = history[:50]
    
    os.makedirs(os.path.dirname(history_path), exist_ok=True)
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

def main():
    parser = argparse.ArgumentParser(description="Project Mikup - Audio Drama Deconstruction Pipeline")
    parser.add_argument("--input", type=str, help="Path to raw audio file", required=True)
    parser.add_argument("--output", type=str, help="Path to output Mikup JSON/Report", default="data/output/mikup_payload.json")
    parser.add_argument("--mock", action="store_true", help="Use mock data for testing")
    
    args = parser.parse_args()
    
    if not os.path.exists(args.input) and not args.mock:
        logger.error(f"Input file {args.input} not found.")
        sys.exit(1)

    try:
        ensure_output_dir(args.output)
    except OSError as exc:
        logger.error("Unable to create output directory for %s: %s", args.output, exc)
        sys.exit(1)
        
    emit_progress("INIT", 0, "Initializing Project Mikup Pipeline...")

    if args.mock:
        emit_progress("MOCK", 50, "Running in MOCK mode...")
        stems = {
            "dialogue_raw": "data/processed/test_Vocals.wav",
            "background_raw": "data/processed/test_Instrumental.wav",
            "dialogue_dry": "data/processed/test_Dry_Vocals.wav",
            "reverb_tail": "data/processed/test_Reverb.wav"
        }
        transcription_path = "data/processed/mock_transcription.json"
    else:
        # Stage 1: Separation
        emit_progress("SEPARATION", 10, "Surgical Separation (UVR5) starting...")
        separator = MikupSeparator(output_dir="data/processed")
        try:
            stems = normalize_and_validate_stems(separator.run_surgical_pipeline(args.input))
            emit_progress("SEPARATION", 25, "Separation complete.")
        except (FileNotFoundError, OSError, RuntimeError, ValueError) as exc:
            logger.error("Stage 1 Separation failed: %s", exc)
            sys.exit(1)
        finally:
            del separator
            flush_vram()
            
        # Stage 2: Transcription
        emit_progress("TRANSCRIPTION", 30, "Transcription & Diarization (WhisperX) starting...")
        transcription_path = "data/processed/transcription.json"
        if is_existing_file(stems.get("dialogue_raw")):
            transcriber = MikupTranscriber()
            try:
                transcription_result = transcriber.transcribe(stems["dialogue_raw"])
                transcription_result = transcriber.diarize(stems["dialogue_raw"], transcription_result, os.getenv("HF_TOKEN"))
                
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
        else:
            logger.warning("No valid dialogue stem found. Skipping Stage 2.")
            try:
                write_empty_transcription(transcription_path)
            except OSError as exc:
                logger.error("Failed to write empty transcription file: %s", exc)
                sys.exit(1)

    # Stage 3: Feature Extraction (DSP)
    emit_progress("DSP", 60, "Feature Extraction (DSP/LUFS) starting...")
    processor = MikupDSPProcessor()
    try:
        dsp_metrics = processor.process_stems(stems, transcription_path)
        emit_progress("DSP", 75, "DSP Analysis complete.")
    except (FileNotFoundError, OSError, RuntimeError, ValueError, json.JSONDecodeError) as exc:
        logger.error("Stage 3 DSP Processing failed: %s", exc)
        sys.exit(1)
    finally:
        del processor
        flush_vram()
    
    # Stage 4: Semantic Audio Understanding (CLAP)
    semantic_tags = []
    if args.mock:
        pass
    elif is_existing_file(stems.get("background_raw")):
        emit_progress("SEMANTICS", 80, "Semantic Tagging (CLAP) starting...")
        tagger = None
        try:
            tagger = MikupSemanticTagger()
            semantic_tags = tagger.tag_audio(stems["background_raw"])
            emit_progress("SEMANTICS", 85, "Semantics complete.")
        except (OSError, RuntimeError, ValueError, AttributeError) as exc:
            logger.error("Stage 4 Semantic Tagging failed: %s", exc)
        finally:
            if tagger is not None:
                del tagger
                flush_vram()
    else:
        logger.warning("No valid background stem found. Skipping Stage 4.")
    
    # Load transcription for payload
    transcription_data = {"segments": []}
    if is_existing_file(transcription_path):
        try:
            with open(transcription_path, "r", encoding="utf-8") as f:
                transcription_data = json.load(f)
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("Failed to load transcription JSON from %s: %s", transcription_path, exc)

    # Final Payload Construction
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
            "stem_paths": generated_stem_paths
        },
    }

    # Stage 5: The AI Director
    if args.mock:
        pass
    else:
        emit_progress("AI_DIRECTOR", 90, "AI Director (Gemini 2.0) synthesis starting...")
        director = MikupDirector()
        report_md = director.generate_report(final_payload)
        if report_md:
            final_payload["ai_report"] = report_md
            report_base, _ = os.path.splitext(args.output)
            report_path = f"{report_base}_report.md"
            try:
                with open(report_path, "w", encoding="utf-8") as f:
                    f.write(report_md)
                logger.info("AI Director report saved to: %s", report_path)
            except OSError as exc:
                logger.error("Failed to save AI Director markdown report: %s", exc)
        else:
            logger.warning("AI Director returned no usable report. Skipping ai_report field.")
        emit_progress("AI_DIRECTOR", 95, "Synthesis complete.")

    # Save final output
    try:
        with open(args.output, "w", encoding="utf-8") as f:
            json.dump(final_payload, f, indent=2)
        logger.info("Pipeline complete. Payload saved to: %s", args.output)
        
        # Update History
        update_history(final_payload)
        
        # Cleanup Stems (preserving disk space)
        if not args.mock:
            cleanup_stems(stems)
            
        emit_progress("COMPLETE", 100, "All stages finished. Results archived.")
    except OSError as exc:
        logger.error("Failed to save final payload: %s", exc)
        sys.exit(1)

if __name__ == "__main__":
    main()
