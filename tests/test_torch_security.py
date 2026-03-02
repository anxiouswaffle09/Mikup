"""Verify that running the main module's security bootstrap registers the expected
safe globals and sets the required env var before any Mikup imports happen."""
import importlib
import os
import sys
import unittest


class TestTorchSecurityRegistry(unittest.TestCase):

    def test_env_var_set_by_bootstrap(self):
        """TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD must be '1' after bootstrap."""
        # Remove any cached import so we can test the side effect
        for key in list(sys.modules.keys()):
            if key == "src.main" or key.startswith("src."):
                del sys.modules[key]

        # Note: TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD is intentionally NOT cleaned up
        # after this test. It represents desired global process state and should
        # persist for the remainder of the Python interpreter's lifetime.

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

    def test_pass2_raises_runtime_error_on_load_failure(self):
        """_pass2_cdx23_instrumental wraps load_model failures in a RuntimeError with guidance."""
        import _pickle
        import tempfile
        import unittest.mock as mock

        from src.ingestion.separator import MikupSeparator

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


if __name__ == "__main__":
    unittest.main()
