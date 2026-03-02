# tests/test_workspace.py
import importlib
import json
import re
import sys
import tempfile
import types
from pathlib import Path

# ── stub heavy dependencies so importing src.main is fast ──────────────────
def _install_stubs():
    for mod in ("dotenv", "torch", "src.ingestion.separator",
                "src.transcription.transcriber", "src.semantics.tagger",
                "src.llm.director"):
        if mod not in sys.modules:
            sys.modules[mod] = types.ModuleType(mod)
    dotenv = sys.modules["dotenv"]
    if not hasattr(dotenv, "load_dotenv"):
        dotenv.load_dotenv = lambda: True
    torch_mod = sys.modules["torch"]
    if not hasattr(torch_mod, "cuda"):
        class _Cuda:
            is_available = staticmethod(lambda: False)
            empty_cache = staticmethod(lambda: None)
        class _Backends:
            class mps:
                is_available = staticmethod(lambda: False)
        torch_mod.cuda = _Cuda()
        torch_mod.backends = _Backends()
        torch_mod.serialization = types.SimpleNamespace(add_safe_globals=lambda x: None)

    sep_mod = sys.modules["src.ingestion.separator"]
    if not hasattr(sep_mod, "MikupSeparator"):
        class MikupSeparator:
            def __init__(self, output_dir=""):
                pass
        sep_mod.MikupSeparator = MikupSeparator

    trans_mod = sys.modules["src.transcription.transcriber"]
    if not hasattr(trans_mod, "MikupTranscriber"):
        class MikupTranscriber:
            pass
        trans_mod.MikupTranscriber = MikupTranscriber

    tagger_mod = sys.modules["src.semantics.tagger"]
    if not hasattr(tagger_mod, "MikupSemanticTagger"):
        class MikupSemanticTagger:
            pass
        tagger_mod.MikupSemanticTagger = MikupSemanticTagger

    director_mod = sys.modules["src.llm.director"]
    if not hasattr(director_mod, "MikupDirector"):
        class MikupDirector:
            pass
        director_mod.MikupDirector = MikupDirector

_install_stubs()
if "src.main" in sys.modules:
    del sys.modules["src.main"]
import src.main as main_mod


def test_resolve_output_dir_uses_config_projects_dir(tmp_path):
    """When --output-dir is absent, workspace is created under config's projects dir."""
    projects_dir = tmp_path / "MyProjects"
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps({"default_projects_dir": str(projects_dir)}))

    result = main_mod._resolve_output_dir(
        input_path="/fake/path/my_audio.wav",
        output_dir_flag=None,
        config_path=str(config_path),
    )

    assert result.startswith(str(projects_dir))
    # Workspace dir name: my_audio_YYYYMMDD_HHMMSS
    name = Path(result).name
    assert name.startswith("my_audio_"), f"Expected 'my_audio_...' got {name!r}"
    assert re.search(r"\d{8}_\d{6}$", name), f"No timestamp suffix in {name!r}"


def test_resolve_output_dir_respects_explicit_flag(tmp_path):
    """When --output-dir is passed, it is returned unchanged (as abspath)."""
    explicit = str(tmp_path / "explicit_workspace")
    result = main_mod._resolve_output_dir(
        input_path="/fake/path/audio.wav",
        output_dir_flag=explicit,
        config_path="/nonexistent/config.json",  # should not be read
    )
    assert result == str(Path(explicit).resolve())


def test_resolve_output_dir_falls_back_to_projects_when_no_config(tmp_path, monkeypatch):
    """When config.json is missing, fallback is <repo_root>/Projects/."""
    monkeypatch.setattr(main_mod, "project_root", str(tmp_path))
    result = main_mod._resolve_output_dir(
        input_path="/fake/path/episode.wav",
        output_dir_flag=None,
        config_path=str(tmp_path / "does_not_exist.json"),
    )
    assert result.startswith(str(tmp_path / "Projects"))
    assert "episode_" in Path(result).name
