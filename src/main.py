import os
import argparse
import json
import gc
import sys
import torch
import logging
from dotenv import load_dotenv

logging.basicConfig(level=logging.INFO)
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
        
    logger.info(f"Starting Project Mikup pipeline...")

    if args.mock:
        logger.info("RUNNING IN MOCK MODE")
        stems = {
            "dialogue_raw": "data/processed/test_Vocals.wav",
            "background_raw": "data/processed/test_Instrumental.wav",
            "dialogue_dry": "data/processed/test_Dry_Vocals.wav",
            "reverb_tail": "data/processed/test_Reverb.wav"
        }
        transcription_path = "data/processed/mock_transcription.json"
    else:
        # Stage 1: Separation
        separator = MikupSeparator(output_dir="data/processed")
        try:
            stems = normalize_and_validate_stems(separator.run_surgical_pipeline(args.input))
        except (FileNotFoundError, OSError, RuntimeError, ValueError) as exc:
            logger.error("Stage 1 Separation failed: %s", exc)
            sys.exit(1)
        finally:
            del separator
            flush_vram()
            
        # Stage 2: Transcription
        transcription_path = "data/processed/transcription.json"
        if is_existing_file(stems.get("dialogue_raw")):
            transcriber = MikupTranscriber()
            try:
                transcription_result = transcriber.transcribe(stems["dialogue_raw"])
                transcription_result = transcriber.diarize(stems["dialogue_raw"], transcription_result, os.getenv("HF_TOKEN"))
                
                transcriber.save_results(transcription_result, transcription_path)
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
    processor = MikupDSPProcessor()
    try:
        dsp_metrics = processor.process_stems(stems, transcription_path)
    except (FileNotFoundError, OSError, RuntimeError, ValueError, json.JSONDecodeError) as exc:
        logger.error("Stage 3 DSP Processing failed: %s", exc)
        sys.exit(1)
    finally:
        del processor
        flush_vram()
    
    # Stage 4: Semantic Audio Understanding (CLAP)
    semantic_tags = []
    if args.mock:
        logger.info("Mock mode: skipping Stage 4 Semantic Tagging.")
    elif is_existing_file(stems.get("background_raw")):
        tagger = None
        try:
            tagger = MikupSemanticTagger()
            semantic_tags = tagger.tag_audio(stems["background_raw"])
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
            "pipeline_version": "0.1.0-alpha"
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
        logger.info("Mock mode: skipping Stage 5 AI Director.")
    else:
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

    # Save final output
    try:
        with open(args.output, "w", encoding="utf-8") as f:
            json.dump(final_payload, f, indent=2)
        logger.info("Pipeline complete. Payload saved to: %s", args.output)
    except OSError as exc:
        logger.error("Failed to save final payload: %s", exc)
        sys.exit(1)

if __name__ == "__main__":
    main()
