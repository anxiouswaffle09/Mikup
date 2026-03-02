"""Verify that running the main module's security bootstrap registers the expected
safe globals and sets the required env var before any Mikup imports happen."""
import importlib
import os
import sys
import types
import unittest


class TestTorchSecurityRegistry(unittest.TestCase):

    def test_env_var_set_by_bootstrap(self):
        """TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD must be '1' after bootstrap."""
        # Remove any cached import so we can test the side effect
        for key in list(sys.modules.keys()):
            if key == "src.main" or key.startswith("src."):
                del sys.modules[key]

        import src.main  # noqa: F401 — side-effects are what we test

        self.assertEqual(
            os.environ.get("TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD"),
            "1",
            "TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD must be '1' after src.main is imported",
        )

    def test_htdemucs_in_safe_globals(self):
        """HTDemucs must appear in torch's safe globals list."""
        import torch

        try:
            from demucs.htdemucs import HTDemucs
        except ImportError:
            self.skipTest("demucs not installed — skipping HTDemucs safe-globals check")

        safe = torch.serialization.get_safe_globals()
        self.assertIn(
            HTDemucs,
            safe,
            "HTDemucs must be registered via torch.serialization.add_safe_globals()",
        )

    def test_numpy_types_in_safe_globals(self):
        """numpy.ndarray and numpy.dtype must appear in torch's safe globals list."""
        import numpy as np
        import torch

        safe = torch.serialization.get_safe_globals()
        self.assertIn(np.ndarray, safe, "np.ndarray must be in safe globals")
        self.assertIn(np.dtype, safe, "np.dtype must be in safe globals")


if __name__ == "__main__":
    unittest.main()
