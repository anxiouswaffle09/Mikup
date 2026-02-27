#!/usr/bin/env python3
"""
Project Mikup - Environment Diagnostic Script
Run with: .venv/bin/python diagnostic.py
"""
import sys
import os
import platform

PASS = "\033[92m[PASS]\033[0m"
FAIL = "\033[91m[FAIL]\033[0m"
WARN = "\033[93m[WARN]\033[0m"
INFO = "\033[94m[INFO]\033[0m"

def check(label, fn):
    try:
        result = fn()
        print(f"{PASS} {label}" + (f": {result}" if result else ""))
        return True
    except Exception as e:
        print(f"{FAIL} {label}: {type(e).__name__}: {e}")
        return False

print("=" * 60)
print("Project Mikup — Environment Diagnostic")
print("=" * 60)

# --- Python & Platform ---
print(f"\n{INFO} Python {sys.version}")
print(f"{INFO} Platform: {platform.platform()}")
print(f"{INFO} Machine: {platform.machine()}")

# --- Core imports ---
print("\n--- Core Imports ---")
check("import torch", lambda: __import__("torch").__version__)
check("import librosa", lambda: __import__("librosa").__version__)
check("import numpy", lambda: __import__("numpy").__version__)
check("import soundfile", lambda: __import__("soundfile").__version__)
check("import dotenv", lambda: __import__("dotenv.main", fromlist=["__version__"]).__version__ if hasattr(__import__("dotenv.main", fromlist=["__version__"]), "__version__") else "imported OK")

# --- Audio separator ---
print("\n--- Audio Separation ---")
def _check_audio_sep():
    import audio_separator
    import importlib.metadata
    try:
        return importlib.metadata.version("audio-separator")
    except Exception:
        return "imported OK"
check("import audio_separator", _check_audio_sep)

def _check_separator_init():
    from audio_separator.separator import Separator
    Separator()
    return "OK"
check("Separator() instantiation", _check_separator_init)

# --- Model name validation ---
print("\n--- Model Name Validation ---")
PASS1_MODEL = "mel_band_roformer_kim_ft_unwa.ckpt"
PASS2_MODEL = "dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt"

def _validate_model(model_filename):
    import json
    models_json_path = os.path.join(
        os.path.dirname(__import__("audio_separator").__file__), "models.json"
    )
    with open(models_json_path) as f:
        registry = json.load(f)
    for section_data in registry.values():
        if isinstance(section_data, dict):
            for model_data in section_data.values():
                if isinstance(model_data, dict) and model_filename in model_data:
                    return f"Found in registry"
    raise ValueError(f"'{model_filename}' not found in audio-separator's model registry")

check(f"Pass 1 model valid ({PASS1_MODEL})", lambda: _validate_model(PASS1_MODEL))
check(f"Pass 2 model valid ({PASS2_MODEL})", lambda: _validate_model(PASS2_MODEL))

# --- Torch device ---
print("\n--- Torch Device Availability ---")
import torch
print(f"{INFO} Torch version: {torch.__version__}")
print(f"{INFO} CUDA available: {torch.cuda.is_available()}")
if hasattr(torch.backends, "mps"):
    mps_ok = torch.backends.mps.is_available()
    print(f"{INFO} MPS (Apple Silicon) available: {mps_ok}")
    if mps_ok:
        print(f"{PASS} Will use MPS for accelerated inference")
    else:
        print(f"{WARN} MPS not available — will fall back to CPU")
else:
    print(f"{WARN} torch.backends.mps not present (older PyTorch?)")

# --- ONNX Runtime ---
print("\n--- ONNX Runtime ---")
def _check_ort():
    import onnxruntime as ort
    providers = ort.get_available_providers()
    return f"v{ort.__version__} | providers: {providers}"
check("onnxruntime", _check_ort)

def _check_no_gpu_ort():
    try:
        import onnxruntime_gpu  # type: ignore
        raise RuntimeError("onnxruntime-gpu is installed — this WILL crash on macOS. Uninstall it and install onnxruntime instead.")
    except ImportError:
        return "onnxruntime-gpu correctly absent"
check("onnxruntime-gpu absent (macOS safety)", _check_no_gpu_ort)

# --- Transcription (optional) ---
print("\n--- Transcription (optional) ---")
def _check_whisperx():
    import whisperx  # type: ignore
    return f"v{getattr(whisperx, '__version__', 'installed')}"
try:
    check("whisperx", _check_whisperx)
except Exception:
    print(f"{WARN} whisperx not installed — Stage 2 will be skipped (expected)")

# --- Semantic tagger ---
print("\n--- Semantic Tagging ---")
check("transformers", lambda: __import__("transformers").__version__)
check("src.semantics.tagger import", lambda: __import__("src.semantics.tagger", fromlist=["MikupSemanticTagger"]) and "OK")

# --- AI Director ---
print("\n--- AI Director (Stage 5) ---")
check("google-genai", lambda: __import__("google.genai", fromlist=["Client"]).__version__ if hasattr(__import__("google.genai", fromlist=["Client"]), "__version__") else "imported OK")

gemini_key = os.getenv("GEMINI_API_KEY")
if gemini_key:
    print(f"{PASS} GEMINI_API_KEY is set")
else:
    print(f"{WARN} GEMINI_API_KEY not set — Stage 5 (AI Director) will be skipped")

# --- Project structure ---
print("\n--- Project Structure ---")
project_root = os.path.dirname(os.path.abspath(__file__))
checks = {
    "src/main.py":       os.path.join(project_root, "src", "main.py"),
    "data/ directory":   os.path.join(project_root, "data"),
    ".env file":         os.path.join(project_root, ".env"),
    ".venv/bin/python3": os.path.join(project_root, ".venv", "bin", "python3"),
}
for label, path in checks.items():
    if os.path.exists(path):
        print(f"{PASS} {label}")
    else:
        flag = WARN if label in (".env file",) else FAIL
        print(f"{flag} {label} missing at {path}")

print("\n" + "=" * 60)
print("Diagnostic complete.")
print("=" * 60)
