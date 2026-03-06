# src/bootstrap.py
"""
System bootstrap for Project Mikup.

Includes:
- Startup banner: prints version and GIL status from versions.json.
- PyTorch security: Registers trusted model classes with torch.serialization.
- Model integrity: Checks for required model weights in the models/ directory.

Call print_startup_banner(), _register_torch_safe_globals(), and
check_model_integrity() at process start.
"""
import collections
import json
import logging
import sysconfig
from pathlib import Path

logger = logging.getLogger(__name__)

_PROJECT_ROOT = Path(__file__).resolve().parent.parent


def load_versions() -> dict:
    """Load the project manifest from versions.json at the repo root."""
    path = _PROJECT_ROOT / "versions.json"
    try:
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError) as exc:
        logger.warning("Could not load versions.json: %s", exc)
        return {}


def print_startup_banner(versions: dict) -> None:
    """Print project version, tech-stack standard, and Python GIL status."""
    project = versions.get("project", "Mikup")
    version = versions.get("version", "unknown")
    standard = versions.get("tech_stack_standard", "unknown")

    print(f"\n{'─' * 52}")
    print(f"  {project} v{version}  |  {standard}")
    print(f"{'─' * 52}")

    gil_disabled = sysconfig.get_config_var("Py_GIL_DISABLED")
    if gil_disabled:
        logger.info("Python free-threaded mode confirmed (GIL disabled).")
        print("  [OK] Python GIL disabled — free-threaded mode active.")
    else:
        logger.warning("Python GIL is active. Free-threaded mode not enabled.")
        print("  [PERF] GIL active — for best performance use Python 3.14t.")

    print()


def _register_torch_safe_globals() -> None:
    """
    Allowlist the exact classes used by our trusted models so that
    torch.load(weights_only=True) does not raise UnpicklingError.
    Only our specific model architectures are registered — not a blanket bypass.

    numpy.core.multiarray._reconstruct is included because virtually every
    checkpoint serializes numpy arrays in its state_dict. Allowlisting it is
    safe here exclusively because (a) model file integrity is verified via
    SHA-256 in MikupSeparator._verify_model_integrity before any weights are
    loaded, and (b) all model sources are pinned in versions.json['ml_models'].
    Do not carry this registration into contexts where weight source or
    integrity cannot be guaranteed.
    """
    import torch

    safe = []

    # collections.OrderedDict — used by torch state_dict serialization
    safe.append(collections.OrderedDict)

    # numpy — used by virtually every checkpoint's state_dict serialization
    try:
        import numpy as np
        safe.extend([np.ndarray, np.dtype])
        try:
            from numpy._core.multiarray import _reconstruct as _np_recon_new
            safe.append(_np_recon_new)
        except ImportError:
            pass
        try:
            from numpy.core.multiarray import _reconstruct as _np_recon_legacy
            safe.append(_np_recon_legacy)
        except ImportError:
            pass
    except ImportError:
        pass

    # demucs HTDemucs — CDX23 cinematic model architecture.
    try:
        from demucs.htdemucs import HTDemucs
        safe.append(HTDemucs)
    except Exception:
        pass

    # omegaconf — used by demucs config serialization
    try:
        from omegaconf.dictconfig import DictConfig
        from omegaconf.listconfig import ListConfig
        safe.extend([DictConfig, ListConfig])
    except ImportError:
        pass

    # pytorch_lightning — used by some BS-Roformer checkpoints
    try:
        from pytorch_lightning.callbacks.model_checkpoint import ModelCheckpoint
        safe.append(ModelCheckpoint)
    except ImportError:
        pass

    if safe:
        torch.serialization.add_safe_globals(safe)
        logger.info("Torch safe globals registered: %d class(es)", len(safe))


def check_model_integrity(versions: dict | None = None) -> None:
    """
    Check if the required model weights are present in the models/ directory.
    Checks are derived from versions.json['ml_models'] to prevent manifest drift.
    """
    if versions is None:
        versions = load_versions()
    models_dir = _PROJECT_ROOT / "models"
    ml_models = versions.get("ml_models", {})

    # Map ml_models keys -> (local subdir, specific filename or None for dir-level check)
    # 'alignment' is fetched at runtime by whisperx — not a local file to check.
    checks: list[tuple[str, str | None]] = [
        ("separation",   ml_models.get("dialogue_separator")),  # specific .ckpt file
        ("cdx23",        None),                                  # dir check only
        ("whisper-small", None),                                 # dir check only
        ("clap",         None),                                  # dir check only
    ]

    if not models_dir.exists():
        logger.critical("CRITICAL: 'models/' directory is missing entirely.")
        print("\n[!] CRITICAL: models/ directory not found.")
        print("Please run: python scripts/download_models.py\n")
        return

    missing = []
    for subdir, filename in checks:
        target = models_dir / subdir
        if not target.exists():
            missing.append(f"{subdir}/" if not filename else f"{subdir}/{filename}")
            continue
        if filename:
            if not (target / filename).exists():
                missing.append(f"{subdir}/{filename}")
        elif not any(target.iterdir()):
            missing.append(f"{subdir}/")

    if missing:
        logger.warning("Missing or empty model components: %s", ", ".join(missing))
        print(f"\n[!] WARNING: Missing or empty model components: {', '.join(missing)}")
        print("Your environment may be out of sync. Please run: python scripts/download_models.py\n")
    else:
        logger.info("Model integrity check passed.")
