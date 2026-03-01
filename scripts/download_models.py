#!/usr/bin/env python3
"""Download required models before first pipeline run.

Includes:
- Stage 1: vocals_mel_band_roformer.ckpt (MBR vocal separator) → models/separation/
- Stage 1: model_bs_roformer_ep_317_sdr_12.9755.ckpt (optional DX refinement) → models/separation/
- CDX23 cinematic demixing models → models/cdx23/
- Whisper small → models/whisper-small/
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

CDX23_MODEL_IDS = [
    "97d170e1-a778de4a.th",
    "97d170e1-dbb4db15.th",
    "97d170e1-e41a5468.th",
]
CDX23_DOWNLOAD_BASE = (
    "https://github.com/ZFTurbo/MVSEP-CDX23-Cinematic-Sound-Demixing"
    "/releases/download/v.1.0.0/"
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
    print("  Preloading separation models via audio-separator...")
    try:
        from audio_separator.separator import Separator
    except Exception as exc:
        print(f"  audio-separator unavailable ({exc}); skipping.")
        return

    model_dir = os.path.join(MODELS_DIR, "separation")
    os.makedirs(model_dir, exist_ok=True)
    separator = Separator(model_file_dir=model_dir)

    for model_name in (PASS1_MODEL,) + PASS2B_MODEL_CANDIDATES:
        try:
            separator.load_model(model_name)
            print(f"  Cached: {model_name} -> models/separation/")
        except Exception as exc:
            print(f"  Could not preload {model_name}: {exc}")


def download_cdx23_models():
    import urllib.request
    cdx23_dir = os.path.join(MODELS_DIR, "cdx23")
    os.makedirs(cdx23_dir, exist_ok=True)
    for model_id in CDX23_MODEL_IDS:
        dest = os.path.join(cdx23_dir, model_id)
        if os.path.exists(dest):
            print(f"  {model_id}: already present, skipping.")
            continue
        url = CDX23_DOWNLOAD_BASE + model_id
        print(f"  Downloading {model_id}...")
        try:
            urllib.request.urlretrieve(url, dest)
            print(f"  Done -> models/cdx23/{model_id}")
        except Exception as exc:
            print(f"  Failed to download {model_id}: {exc}")


if __name__ == "__main__":
    print("Downloading Mikup models...\n")
    print("[1/4] Stage 1 separation models (MBR + BS-Roformer) -> models/separation/")
    download_separation_models()
    print("\n[2/4] CDX23 cinematic demixing models -> models/cdx23/")
    download_cdx23_models()
    print("\n[3/4] faster-whisper (Systran/faster-whisper-small) -> models/whisper-small/")
    download_whisper()
    print("\n[4/4] pyannote diarization")
    download_pyannote()
    print("\nAll done.")
