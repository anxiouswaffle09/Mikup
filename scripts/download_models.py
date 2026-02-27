#!/usr/bin/env python3
"""Download Stage 2 models before first pipeline run.

Whisper small  → models/whisper-small/   (loaded by path; no network at runtime)
pyannote 3.1   → HuggingFace cache       (pre-populated; Pipeline loads instantly)

Usage:
    .venv/bin/python3 scripts/download_models.py

Requirements:
    - HF_TOKEN in .env (only needed for pyannote)
    - HuggingFace account with accepted terms for:
        https://huggingface.co/pyannote/segmentation-3.0
        https://huggingface.co/pyannote/speaker-diarization-3.1
"""

import os
import sys

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS_DIR = os.path.join(PROJECT_ROOT, "models")
sys.path.insert(0, PROJECT_ROOT)

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(PROJECT_ROOT, ".env"))
except ImportError:
    pass

HF_TOKEN = os.environ.get("HF_TOKEN")


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
        print("  HF_TOKEN not set in .env — skipping pyannote.")
        print("  Add HF_TOKEN to .env and re-run to pre-download pyannote.")
        return

    from huggingface_hub import snapshot_download

    # segmentation-3.0 is a dependency of speaker-diarization-3.1;
    # both must be in cache or pyannote will attempt a network fetch at runtime.
    repos = [
        "pyannote/segmentation-3.0",
        "pyannote/speaker-diarization-3.1",
    ]
    for repo_id in repos:
        print(f"  Downloading {repo_id} to HF cache...")
        snapshot_download(repo_id=repo_id, token=HF_TOKEN)
        print(f"  Done.")


if __name__ == "__main__":
    print("Downloading Stage 2 models...\n")

    print("[1/2] faster-whisper (Systran/faster-whisper-small)")
    download_whisper()

    print("\n[2/2] pyannote diarization (pyannote/speaker-diarization-3.1)")
    download_pyannote()

    print("\nAll done. First pipeline run will load from local cache.")
