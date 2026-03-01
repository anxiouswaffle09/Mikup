import importlib
import json
import sys
import types
from pathlib import Path
from unittest.mock import patch


def _install_dependency_stubs() -> None:
    dotenv_mod = types.ModuleType("dotenv")

    def load_dotenv() -> bool:
        return True

    dotenv_mod.load_dotenv = load_dotenv
    sys.modules["dotenv"] = dotenv_mod

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

    torch_mod.cuda = _Cuda()
    torch_mod.backends = _Backends()
    sys.modules["torch"] = torch_mod

    separator_mod = types.ModuleType("src.ingestion.separator")

    class MikupSeparator:
        def __init__(self, output_dir: str):
            self.output_dir = output_dir

        @staticmethod
        def _write_silent_wav(path: str, duration_seconds: float = 3.0, sample_rate: int = 22050, channels: int = 2):
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            Path(path).write_bytes(b"")

        def run_surgical_pipeline(self, input_path: str, fast_mode: bool = False):
            return {
                "DX": str(Path(self.output_dir) / "dx.wav"),
                "Music": str(Path(self.output_dir) / "music.wav"),
                "Foley": str(Path(self.output_dir) / "foley.wav"),
                "SFX": str(Path(self.output_dir) / "sfx.wav"),
                "Ambience": str(Path(self.output_dir) / "ambience.wav"),
                "DX_Residual": str(Path(self.output_dir) / "dx_residual.wav"),
                "Dialogue": str(Path(self.output_dir) / "dialogue.wav"),
                "Effects": str(Path(self.output_dir) / "effects.wav"),
            }

    separator_mod.MikupSeparator = MikupSeparator
    sys.modules["src.ingestion.separator"] = separator_mod

    transcriber_mod = types.ModuleType("src.transcription.transcriber")

    class MikupTranscriber:
        def transcribe(self, _audio_path: str, fast_mode: bool = False):
            return {"segments": []}

        def diarize(self, _audio_path: str, transcription_result: dict, _hf_token=None):
            return transcription_result

        def save_results(self, payload: dict, output_path: str):
            Path(output_path).parent.mkdir(parents=True, exist_ok=True)
            with open(output_path, "w", encoding="utf-8") as file_obj:
                json.dump(payload, file_obj)

    transcriber_mod.MikupTranscriber = MikupTranscriber
    sys.modules["src.transcription.transcriber"] = transcriber_mod

    tagger_mod = types.ModuleType("src.semantics.tagger")

    class MikupSemanticTagger:
        def tag_audio(self, _audio_path: str):
            return []

    tagger_mod.MikupSemanticTagger = MikupSemanticTagger
    sys.modules["src.semantics.tagger"] = tagger_mod

    director_mod = types.ModuleType("src.llm.director")

    class MikupDirector:
        def __init__(self, payload_path: str, workspace_dir: str):
            self.payload_path = payload_path
            self.workspace_dir = workspace_dir

        def generate_report(self, _payload: dict):
            return "Stub report"

    director_mod.MikupDirector = MikupDirector
    sys.modules["src.llm.director"] = director_mod


def load_main_module():
    _install_dependency_stubs()
    if "src.main" in sys.modules:
        del sys.modules["src.main"]
    return importlib.import_module("src.main")


def run_main(main_module, args: list[str]):
    with patch.object(sys, "argv", ["main.py", *args]):
        return main_module.main()
