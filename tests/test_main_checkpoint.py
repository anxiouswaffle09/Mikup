import json
import tempfile
import unittest
from pathlib import Path

from tests._pipeline_test_utils import load_main_module, run_main


def _read_json(path: Path):
    with path.open("r", encoding="utf-8") as file_obj:
        return json.load(file_obj)


class MainCheckpointSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.main_module = load_main_module()

    def test_mock_full_pipeline_writes_artifacts_under_data(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir) / "workspace"
            run_main(
                self.main_module,
                ["--input", "dummy.wav", "--mock", "--output-dir", str(output_dir)],
            )

            data_dir = output_dir / "data"
            stage_state_path = data_dir / "stage_state.json"
            stems_path = data_dir / "stems.json"
            transcription_path = data_dir / "transcription.json"
            semantics_path = data_dir / "semantics.json"

            self.assertTrue(stage_state_path.exists())
            self.assertTrue(stems_path.exists())
            self.assertTrue(transcription_path.exists())
            self.assertTrue(semantics_path.exists())

            stems_payload = _read_json(stems_path)
            for key in ("DX", "Music", "Effects"):
                self.assertIn(key, stems_payload)
                self.assertIsInstance(stems_payload[key], str)
                self.assertTrue(stems_payload[key].strip())

            # Contract regression guard: artifacts now live in output_dir/data/, not output_dir/.
            self.assertFalse((output_dir / "stage_state.json").exists())
            self.assertFalse((output_dir / "stems.json").exists())

            state = _read_json(stage_state_path)
            self.assertTrue(state["artifacts"]["stage_state"].endswith("data/stage_state.json"))
            self.assertTrue(state["artifacts"]["stems"].endswith("data/stems.json"))
            self.assertTrue(
                state["artifacts"]["transcription"].endswith("data/transcription.json")
            )
            self.assertTrue(state["artifacts"]["semantics"].endswith("data/semantics.json"))

            for stage in ("separation", "transcription", "dsp", "semantics", "director"):
                self.assertIs(state["stages"][stage]["completed"], True)

    def test_manual_stage_progression_updates_checkpoint_state(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir) / "workspace"

            run_main(
                self.main_module,
                [
                    "--input",
                    "dummy.wav",
                    "--mock",
                    "--output-dir",
                    str(output_dir),
                    "--stage",
                    "separation",
                ],
            )

            run_main(
                self.main_module,
                [
                    "--input",
                    "dummy.wav",
                    "--mock",
                    "--output-dir",
                    str(output_dir),
                    "--stage",
                    "transcription",
                ],
            )

            run_main(
                self.main_module,
                [
                    "--input",
                    "dummy.wav",
                    "--mock",
                    "--output-dir",
                    str(output_dir),
                    "--stage",
                    "dsp",
                ],
            )

            state = _read_json(output_dir / "data" / "stage_state.json")
            self.assertIs(state["stages"]["separation"]["completed"], True)
            self.assertIs(state["stages"]["transcription"]["completed"], True)
            self.assertIs(state["stages"]["dsp"]["completed"], True)


if __name__ == "__main__":
    unittest.main()
