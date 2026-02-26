import os
import argparse
import json
import gc
import torch
from dotenv import load_dotenv
from src.ingestion.separator import MikupSeparator
from src.transcription.transcriber import MikupTranscriber
from src.dsp.processor import MikupDSPProcessor
from src.semantics.tagger import MikupSemanticTagger

# Load environment variables
load_dotenv()

def flush_vram():
    """Forcefully clear VRAM and RAM cache."""
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        # MPS doesn't have an explicit empty_cache but gc.collect helps
        pass

def main():
    parser = argparse.ArgumentParser(description="Project Mikup - Audio Drama Deconstruction Pipeline")
    parser.add_argument("--input", type=str, help="Path to raw audio file", required=True)
    parser.add_argument("--output", type=str, help="Path to output Mikup JSON/Report", default="data/output/mikup_payload.json")
    parser.add_argument("--mock", action="store_true", help="Use mock data for testing")
    
    args = parser.parse_args()
    
    if not os.path.exists(args.input) and not args.mock:
        print(f"Error: Input file {args.input} not found.")
        return
        
    print(f"Starting Project Mikup pipeline...")

    if args.mock:
        print("⚠️ RUNNING IN MOCK MODE")
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
        stems = separator.run_surgical_pipeline(args.input)
        del separator
        flush_vram()
        
        # Stage 2: Transcription
        transcriber = MikupTranscriber()
        transcription_result = transcriber.transcribe(stems["dialogue_raw"])
        transcription_result = transcriber.diarize(stems["dialogue_raw"], transcription_result, os.getenv("HF_TOKEN"))
        
        transcription_path = "data/processed/transcription.json"
        transcriber.save_results(transcription_result, transcription_path)
        del transcriber
        flush_vram()

    # Stage 3: Feature Extraction (DSP)
    processor = MikupDSPProcessor()
    dsp_metrics = processor.process_stems(stems, transcription_path)
    
    # Stage 4: Semantic Audio Understanding (CLAP)
    tagger = MikupSemanticTagger()
    semantic_tags = []
    if stems.get("background_raw"):
        # Tag the background/instrumental stem
        semantic_tags = tagger.tag_audio(stems["background_raw"])
    
    del tagger
    flush_vram()
    
    # Load transcription for payload
    with open(transcription_path, 'r') as f:
        transcription_data = json.load(f)

    # Final Payload Construction
    final_payload = {
        "metadata": {
            "source_file": args.input,
            "pipeline_version": "0.1.0-alpha"
        },
        "transcription": transcription_data,
        "metrics": dsp_metrics,
        "semantics": {
            "background_tags": semantic_tags
        }
    }

    # Save final output
    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    with open(args.output, 'w') as f:
        json.dump(final_payload, f, indent=2)

    print(f"✅ Pipeline complete! Payload saved to: {args.output}")

if __name__ == "__main__":
    main()
