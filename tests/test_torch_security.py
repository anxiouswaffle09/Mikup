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
        # Stub audio_separator and all other heavy deps so they don't need
        # real C extensions.
        audio_sep_mod = types.ModuleType("audio_separator")
        audio_sep_sep_mod = types.ModuleType("audio_separator.separator")
        audio_sep_sep_mod.Separator = mock.MagicMock()
        audio_sep_mod.separator = audio_sep_sep_mod

        # Stub librosa, onnxruntime, soundfile — module-level imports in separator.py
        librosa_mod = types.ModuleType("librosa")
        ort_mod = types.ModuleType("onnxruntime")
        sf_mod = types.ModuleType("soundfile")

        # Stub demucs submodules needed by _pass2_cdx23_instrumental inline imports
        demucs_mod = types.ModuleType("demucs")
        demucs_states_mod = types.ModuleType("demucs.states")
        demucs_states_mod.load_model = mock.MagicMock()
        demucs_apply_mod = types.ModuleType("demucs.apply")
        demucs_apply_mod.apply_model = mock.MagicMock()
        demucs_htdemucs_mod = types.ModuleType("demucs.htdemucs")
        MockHTDemucs = mock.MagicMock()
        MockHTDemucs.__name__ = "HTDemucs"
        demucs_htdemucs_mod.HTDemucs = MockHTDemucs

        extra_stubs = {
            "audio_separator": audio_sep_mod,
            "audio_separator.separator": audio_sep_sep_mod,
            "librosa": librosa_mod,
            "onnxruntime": ort_mod,
            "soundfile": sf_mod,
            "demucs": demucs_mod,
            "demucs.states": demucs_states_mod,
            "demucs.apply": demucs_apply_mod,
            "demucs.htdemucs": demucs_htdemucs_mod,
        }

        with tempfile.NamedTemporaryFile(suffix=".th", delete=False) as tmp:
            fake_model_path = tmp.name

        try:
            with mock.patch.dict(sys.modules, extra_stubs):
                # Remove stub separator so Python imports real separator.py
                sys.modules.pop("src.ingestion.separator", None)
                sys.modules.pop("src.ingestion", None)
                from src.ingestion import separator as sep_module
                MikupSeparator = sep_module.MikupSeparator

                sep = MikupSeparator.__new__(MikupSeparator)
                sep.output_dir = "/tmp"
                sep.device = "cpu"

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
