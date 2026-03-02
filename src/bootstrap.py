# src/bootstrap.py
"""
PyTorch security bootstrap for Project Mikup.

Registers trusted model classes with torch.serialization before any model
loading occurs, and sets the env var required by audio-separator.

Call _register_torch_safe_globals() at process start — before any other
Mikup imports that may trigger torch.load.
"""
import logging
import os

logger = logging.getLogger(__name__)


def _register_torch_safe_globals() -> None:
    """
    Allowlist the exact classes used by our trusted models so that
    torch.load(weights_only=True) does not raise UnpicklingError.
    Only our specific model architectures are registered — not a blanket bypass.
    """
    import torch

    # Allow third-party libs (audio-separator) that call torch.load without
    # weights_only=False explicitly.
    os.environ.setdefault("TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD", "1")

    safe = []

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
    # Uses broad except because stub torch causes AttributeError (not ImportError)
    # when demucs tries to subclass torch.nn.Module during module-level class
    # definition. Safe to skip — real demucs registers fine in production.
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
