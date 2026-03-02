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
