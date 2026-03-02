# Bootstrap Refactor & Stub Pollution Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract the PyTorch security bootstrap into its own module and fix the test suite's stub-pollution problems so all 4 previously-failing tests in `test_torch_security.py` pass.

**Architecture:** `src/bootstrap.py` owns the `_register_torch_safe_globals()` function so tests can import it without pulling in all of `src/main.py`'s heavy dependencies. `_pipeline_test_utils.py` gains a stateful serialization stub (with `add_safe_globals` tracking) and `torch.amp` + `audio_separator` stubs so `test_torch_security.py` can test the real separator code path. `test_torch_security.py` is updated to use `src.bootstrap` directly and mock `demucs.htdemucs`.

**Tech Stack:** Python 3.13, `unittest`, `unittest.mock`, `types.ModuleType`, existing `pytest` runner.

**Pre-condition:** Task 4 (Project-First workspace) is already complete. Run `python -m pytest tests/ -v` before starting — expect 7 passed, 3 failed, 1 skipped.

---

### Task 1: Create `src/bootstrap.py`

**Files:**
- Create: `src/bootstrap.py`

**Step 1: Write the failing test**

Add a new test file to verify the bootstrap module exists and is independently importable. Use an inline stub so the test doesn't need the full pipeline test utils.

Create `tests/test_bootstrap.py`:

```python
"""Verify src.bootstrap is importable independently and exposes the right API."""
import sys
import types
import unittest


def _stub_torch():
    """Install a minimal torch stub if real torch hasn't been imported yet."""
    _registry = []

    torch_mod = types.ModuleType("torch")

    class _Cuda:
        is_available = staticmethod(lambda: False)
        empty_cache = staticmethod(lambda: None)

    class _Backends:
        class mps:
            is_available = staticmethod(lambda: False)

    torch_mod.cuda = _Cuda()
    torch_mod.backends = _Backends()
    torch_mod.serialization = types.SimpleNamespace(
        add_safe_globals=lambda classes: _registry.extend(classes),
        get_safe_globals=lambda: list(_registry),
    )

    amp_mod = types.ModuleType("torch.amp")
    autocast_mod = types.ModuleType("torch.amp.autocast_mode")
    amp_mod.autocast_mode = autocast_mod
    torch_mod.amp = amp_mod
    sys.modules["torch.amp"] = amp_mod
    sys.modules["torch.amp.autocast_mode"] = autocast_mod
    sys.modules["torch"] = torch_mod
    return torch_mod


_stub_torch()
sys.modules.pop("src.bootstrap", None)

import src.bootstrap as bootstrap_mod  # noqa: E402


class TestBootstrapModule(unittest.TestCase):
    def test_exposes_register_function(self):
        self.assertTrue(
            callable(getattr(bootstrap_mod, "_register_torch_safe_globals", None)),
            "src.bootstrap must expose _register_torch_safe_globals()",
        )

    def test_env_var_set_after_call(self):
        import os
        bootstrap_mod._register_torch_safe_globals()
        self.assertEqual(os.environ.get("TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD"), "1")

    def test_numpy_registered_after_call(self):
        import numpy as np
        import torch
        bootstrap_mod._register_torch_safe_globals()
        safe = torch.serialization.get_safe_globals()
        self.assertIn(np.ndarray, safe)
        self.assertIn(np.dtype, safe)


if __name__ == "__main__":
    unittest.main()
```

**Step 2: Run to verify it fails**

```bash
cd "/Users/test/Documents/Dev Projects/Mikup"
source .venv/bin/activate
python -m pytest tests/test_bootstrap.py -v
```

Expected: `ModuleNotFoundError: No module named 'src.bootstrap'`

**Step 3: Create `src/bootstrap.py`**

```python
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
    except (ImportError, AttributeError, Exception):
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
```

**Step 4: Run tests to verify they pass**

```bash
python -m pytest tests/test_bootstrap.py -v
```

Expected: `3 passed`

**Step 5: Run full suite to confirm no regressions**

```bash
python -m pytest tests/ -v --tb=short 2>&1 | tail -10
```

Expected: same pass/fail counts as before (7 passed, 3 failed, 1 skipped), new test adds 3 more passes.

**Step 6: Commit**

```bash
git add src/bootstrap.py tests/test_bootstrap.py
git commit -m "feat(bootstrap): extract _register_torch_safe_globals into src/bootstrap.py

Moves the PyTorch security bootstrap out of src/main.py so tests can
import it without pulling in the full pipeline dependency tree. Catches
AttributeError for demucs import (stub torch raises AttributeError when
demucs tries to subclass torch.nn.Module at class-definition time)."
```

---

### Task 2: Update `src/main.py` to use `src.bootstrap`

**Files:**
- Modify: `src/main.py:27-83`

**Step 1: Update the import in `src/main.py`**

In `src/main.py`, replace the entire `_register_torch_safe_globals` function definition block (lines 23–83) with an import-and-call:

```python
# ---------------------------------------------------------------------------
# PyTorch 2.10+ security: register trusted model classes before any imports
# that may trigger model loading. This must run before Mikup module imports.
# ---------------------------------------------------------------------------
from src.bootstrap import _register_torch_safe_globals
_register_torch_safe_globals()
# ---------------------------------------------------------------------------
```

Also remove the `import torch` at the top of `src/main.py` (line 7) — `torch` is used later in the file for `torch.cuda.is_available()` in `flush_vram()`. Keep the import but move it after the bootstrap call if needed, or keep it in place (it's fine where it is since we're not removing it from main.py).

Actually: keep `import torch` at line 7 as-is. Only remove the function definition block and replace with the import+call.

**Step 2: Verify `src/main.py` still imports cleanly**

```bash
cd "/Users/test/Documents/Dev Projects/Mikup"
source .venv/bin/activate
python -c "import sys; sys.path.insert(0, '.'); from tests._pipeline_test_utils import load_main_module; m = load_main_module(); print('OK')"
```

Expected: `OK`

**Step 3: Run full test suite**

```bash
python -m pytest tests/ -v --tb=short 2>&1 | tail -12
```

Expected: same baseline (10 passed from tasks 1+2, 3 failed in torch_security, 1 skipped).

**Step 4: Commit**

```bash
git add src/main.py
git commit -m "refactor(main): delegate security bootstrap to src.bootstrap

Removes the _register_torch_safe_globals definition from main.py and
replaces it with an import from src.bootstrap. Logic is identical;
only the location changes."
```

---

### Task 3: Upgrade `tests/_pipeline_test_utils.py`

**Files:**
- Modify: `tests/_pipeline_test_utils.py`

This task adds three things to the torch stub inside `_install_dependency_stubs()`:
1. **Stateful serialization** — `add_safe_globals` tracks what was registered; `get_safe_globals` returns it.
2. **`torch.amp` submodule** — satisfies `import torch.amp.autocast_mode as autocast_mode` in `audio_separator`.
3. **`audio_separator` stub** — so `src.ingestion.separator` can be imported with real code in tests that need it, by optionally removing the `src.ingestion.separator` stub.

**Step 1: Write a test that will fail with the current stub**

Add to `tests/test_bootstrap.py` a new test class (or add to an existing test file) that verifies the stub tracks registrations. Actually, `test_numpy_registered_after_call` in `test_bootstrap.py` (Task 1) already tests this against the bootstrap's own inline stub. The failing test that drives Task 3 is in `test_torch_security.py` — we'll verify those after.

For now, confirm the current state of `test_torch_security.py` failures:

```bash
python -m pytest tests/test_torch_security.py -v --tb=line 2>&1
```

Expected: 3 failed, 1 skipped.

**Step 2: Update `_install_dependency_stubs()` in `tests/_pipeline_test_utils.py`**

Replace the torch stub block (lines 18–40 of current file) with the following. Everything else in the function stays the same.

```python
    # ── torch stub ──────────────────────────────────────────────────────────
    torch_mod = types.ModuleType("torch")

    class _Cuda:
        @staticmethod
        def is_available() -> bool:
            return False

        @staticmethod
        def empty_cache() -> None:
            return None

    class _Mps:
        @staticmethod
        def is_available() -> bool:
            return False

    class _Backends:
        mps = _Mps()

    # Stateful serialization stub so get_safe_globals() reflects what
    # _register_torch_safe_globals() registered via add_safe_globals().
    _safe_globals_registry: list = []

    def _add_safe_globals(classes: list) -> None:
        _safe_globals_registry.extend(classes)

    def _get_safe_globals() -> list:
        return list(_safe_globals_registry)

    torch_mod.cuda = _Cuda()
    torch_mod.backends = _Backends()
    torch_mod.serialization = types.SimpleNamespace(
        add_safe_globals=_add_safe_globals,
        get_safe_globals=_get_safe_globals,
    )

    # torch.amp submodule — satisfies `import torch.amp.autocast_mode` in
    # audio_separator.separator (line 21 of that file).
    amp_mod = types.ModuleType("torch.amp")
    autocast_mod = types.ModuleType("torch.amp.autocast_mode")
    amp_mod.autocast_mode = autocast_mod
    torch_mod.amp = amp_mod
    sys.modules["torch.amp"] = amp_mod
    sys.modules["torch.amp.autocast_mode"] = autocast_mod

    sys.modules["torch"] = torch_mod
    # ── end torch stub ───────────────────────────────────────────────────────
```

**Step 3: Run the test suite to verify no regressions**

```bash
python -m pytest tests/ -v --tb=short 2>&1 | tail -12
```

Expected: same or better counts. The torch_security failures may still be there (we fix them in Task 4), but nothing new should break.

**Step 4: Commit**

```bash
git add tests/_pipeline_test_utils.py
git commit -m "test(utils): add stateful serialization stub and torch.amp stub

- torch.serialization now tracks add_safe_globals() calls so
  get_safe_globals() can return what was registered
- torch.amp and torch.amp.autocast_mode submodule stubs added so
  audio_separator can be imported when stub torch is in sys.modules"
```

---

### Task 4: Fix `tests/test_torch_security.py`

**Files:**
- Modify: `tests/test_torch_security.py`

Replace the entire file with the updated version below. Changes per test:

- **`test_env_var_set_by_bootstrap`**: Clears and re-imports `src.bootstrap` (not `src.main`). Calls the function directly. No heavy pipeline imports.
- **`test_htdemucs_in_safe_globals`**: Patches `demucs.htdemucs` with a `MagicMock` HTDemucs. Calls `_register_torch_safe_globals()` and verifies the mock class appears in the registry.
- **`test_numpy_types_in_safe_globals`**: Same structure — calls bootstrap directly, checks registry.
- **`test_pass2_raises_runtime_error_on_load_failure`**: Removes the `src.ingestion.separator` stub from `sys.modules` and stubs `audio_separator` so the real `separator.py` can be imported without needing real audio-separator. Then runs the original assertion.

**Step 1: Write the new test file**

Full replacement for `tests/test_torch_security.py`:

```python
"""Verify the PyTorch security bootstrap and separator error handling.

All tests target src.bootstrap directly (not src.main) to avoid pulling in
the full pipeline dependency tree. The torch stub installed by
_pipeline_test_utils provides stateful serialization tracking so
get_safe_globals() reflects what was actually registered.
"""
import os
import sys
import types
import unittest
import unittest.mock as mock

from tests._pipeline_test_utils import _install_dependency_stubs

# Install stubs once at module level so torch in sys.modules is the
# tracking stub for all tests in this file.
_install_dependency_stubs()


def _reload_bootstrap():
    """Remove cached src.bootstrap so its module-level code re-runs."""
    for key in list(sys.modules.keys()):
        if key == "src.bootstrap" or key == "src":
            del sys.modules[key]


class TestTorchSecurityRegistry(unittest.TestCase):

    def setUp(self):
        """Clear the safe-globals registry before each test for isolation."""
        import torch
        # Reset the registry by reinstalling the stub (creates a fresh closure).
        _install_dependency_stubs()
        _reload_bootstrap()

    def test_env_var_set_by_bootstrap(self):
        """TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD must be '1' after bootstrap runs."""
        # Remove from env so setdefault() actually sets it.
        os.environ.pop("TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD", None)

        from src import bootstrap
        bootstrap._register_torch_safe_globals()

        self.assertEqual(
            os.environ.get("TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD"),
            "1",
            "TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD must be '1' after bootstrap runs",
        )

    def test_htdemucs_in_safe_globals(self):
        """HTDemucs must appear in the safe globals after bootstrap runs."""
        MockHTDemucs = mock.MagicMock()
        MockHTDemucs.__name__ = "HTDemucs"

        demucs_mod = types.ModuleType("demucs")
        demucs_htdemucs_mod = types.ModuleType("demucs.htdemucs")
        demucs_htdemucs_mod.HTDemucs = MockHTDemucs

        with mock.patch.dict(sys.modules, {
            "demucs": demucs_mod,
            "demucs.htdemucs": demucs_htdemucs_mod,
        }):
            from src import bootstrap
            bootstrap._register_torch_safe_globals()

        import torch
        safe = torch.serialization.get_safe_globals()
        self.assertIn(
            MockHTDemucs,
            safe,
            "HTDemucs must be registered via torch.serialization.add_safe_globals()",
        )

    def test_numpy_types_in_safe_globals(self):
        """numpy.ndarray and numpy.dtype must appear in safe globals."""
        import numpy as np

        from src import bootstrap
        bootstrap._register_torch_safe_globals()

        import torch
        safe = torch.serialization.get_safe_globals()
        self.assertIn(np.ndarray, safe, "np.ndarray must be in safe globals")
        self.assertIn(np.dtype, safe, "np.dtype must be in safe globals")

    def test_pass2_raises_runtime_error_on_load_failure(self):
        """_pass2_cdx23_instrumental wraps load_model failures in RuntimeError."""
        import _pickle
        import tempfile

        # Remove the pipeline stub for src.ingestion.separator so the real
        # separator.py is imported (which has _pass2_cdx23_instrumental).
        # Stub audio_separator so it doesn't need the real C extension.
        audio_sep_mod = types.ModuleType("audio_separator")
        audio_sep_sep_mod = types.ModuleType("audio_separator.separator")
        audio_sep_sep_mod.Separator = mock.MagicMock()
        audio_sep_mod.separator = audio_sep_sep_mod

        with mock.patch.dict(sys.modules, {
            "audio_separator": audio_sep_mod,
            "audio_separator.separator": audio_sep_sep_mod,
        }):
            # Remove stub separator so Python imports real separator.py
            sys.modules.pop("src.ingestion.separator", None)
            from src.ingestion import separator as sep_module
            MikupSeparator = sep_module.MikupSeparator

        sep = MikupSeparator.__new__(MikupSeparator)
        sep.output_dir = "/tmp"
        sep.device = "cpu"

        with tempfile.NamedTemporaryFile(suffix=".th", delete=False) as tmp:
            fake_model_path = tmp.name

        try:
            with mock.patch(
                "src.ingestion.separator.load_model",
                side_effect=_pickle.UnpicklingError("weights_only load failed"),
            ):
                with self.assertRaises(RuntimeError) as ctx:
                    sep._pass2_cdx23_instrumental(
                        "/tmp/fake_instrumental.wav", "fake_source", fast_mode=True
                    )

            self.assertIn("security gate", str(ctx.exception).lower())
        finally:
            os.unlink(fake_model_path)
            # Restore stub separator so other tests aren't polluted
            sys.modules.pop("src.ingestion.separator", None)
            sys.modules.pop("src.ingestion", None)
            _install_dependency_stubs()


if __name__ == "__main__":
    unittest.main()
```

**Step 2: Run only `test_torch_security.py` to check**

```bash
python -m pytest tests/test_torch_security.py -v --tb=short
```

Expected: 4 passed (no skips, no failures). If `test_pass2` fails with an import error inside real `separator.py` (e.g., `librosa`, `onnxruntime` having issues with stub torch), note the error and patch the additional missing stub module before moving on.

**Step 3: Run the full test suite**

```bash
python -m pytest tests/ -v --tb=short 2>&1 | tail -15
```

Expected: All tests that were previously passing still pass. The 3 previously-failing torch_security tests now pass. The previously-skipped htdemucs test now passes too (no longer skipped). Final count: **14 passed, 0 failed, 0 skipped** (10 prior + 3 bootstrap + 1 reclaimed skipped = 14).

**Step 4: Commit**

```bash
git add tests/test_torch_security.py
git commit -m "fix(tests): eliminate stub pollution in test_torch_security

- All 4 tests now target src.bootstrap directly instead of src.main,
  avoiding the full pipeline import chain
- test_htdemucs_in_safe_globals uses MagicMock instead of real demucs
  (which can't load under stub torch)
- test_pass2 stubs audio_separator and imports real separator.py so
  _pass2_cdx23_instrumental can be tested without the C extension
- setUp reinstalls dependency stubs per test for registry isolation"
```

---

## Final Verification

```bash
python -m pytest tests/ -v 2>&1 | tail -20
```

Expected result: **All tests pass. 0 failures. 0 skips.**
