#!/usr/bin/env python3
"""Download required models before first pipeline run.

Includes:
- Stage 1: vocals_mel_band_roformer.ckpt (MBR vocal separator)
- Stage 1: model_bs_roformer_ep_317_sdr_12.9755.ckpt (optional DX refinement)
- CDX23 models are auto-downloaded to ~/.cache/mikup/cdx23/ on first run.
- Whisper small (local path loading)
- pyannote diarization dependencies

Usage:
    .venv/bin/python3 scripts/download_models.py
"""

import os
import sys

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS_DIR = os.path.join(PROJECT_ROOT, "models")
sys.path.insert(0, PROJECT_ROOT)

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(PROJECT_ROOT, ".env"), override=True)
except ImportError:
    pass

HF_TOKEN = os.environ.get("HF_TOKEN")

PASS1_MODEL = "vocals_mel_band_roformer.ckpt"
PASS2B_MODEL_CANDIDATES = (
    "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
    "BS-Roformer-Viperx-1297.ckpt",
)


def download_whisper():
    dest = os.path.join(MODELS_DIR, "whisper-small")
    if os.path.exists(os.path.join(dest, "model.bin")):
        print("  whisper-small: already present, skipping.")
        return
    print("  Downloading Systran/faster-whisper-small (~244 MB)...")
    from huggingface_hub import snapshot_download
    os.makedirs(MODELS_DIR, exist_ok=True)
    snapshot_download(repo_id="Systran/faster-whisper-small", local_dir=dest)
    print("  Done -> models/whisper-small/")


def download_pyannote():
    if not HF_TOKEN:
        print("  HF_TOKEN not set in .env - skipping pyannote.")
        return
    from huggingface_hub import snapshot_download
    for repo_id in ["pyannote/segmentation-3.0", "pyannote/speaker-diarization-3.1"]:
        print(f"  Downloading {repo_id} to HF cache...")
        snapshot_download(repo_id=repo_id, token=HF_TOKEN)
        print("  Done.")


def download_separation_models():
    print("  Preloading separation models via audio-separator cache...")
    try:
        from audio_separator.separator import Separator
    except Exception as exc:
        print(f"  audio-separator unavailable ({exc}); skipping.")
        return

    cache_dir = os.path.join(MODELS_DIR, "separation")
    os.makedirs(cache_dir, exist_ok=True)
    separator = Separator(output_dir=cache_dir)

    for model_name in (PASS1_MODEL,) + PASS2B_MODEL_CANDIDATES:
        try:
            separator.load_model(model_name)
            print(f"  Cached: {model_name}")
        except Exception as exc:
            print(f"  Could not preload {model_name}: {exc}")

    print("  Note: CDX23 models auto-download to ~/.cache/mikup/cdx23/ on first run.")


if __name__ == "__main__":
    print("Downloading Mikup models...\n")
    print("[1/3] Stage 1 separation models (MBR + BS-Roformer)")
    download_separation_models()
    print("\n[2/3] faster-whisper (Systran/faster-whisper-small)")
    download_whisper()
    print("\n[3/3] pyannote diarization")
    download_pyannote()
    print("\nAll done. CDX23 models download automatically on first pipeline run.")
