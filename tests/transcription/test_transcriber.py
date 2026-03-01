import json
import tempfile
import unittest
from pathlib import Path

from tests._pipeline_test_utils import load_main_module, run_main


class TranscriptionStageSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.main_module = load_main_module()

    def test_transcription_stage_requires_existing_separation_artifacts(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir) / "workspace"
            with self.assertRaises(SystemExit) as raised:
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
            self.assertEqual(raised.exception.code, 1)

    def test_transcription_stage_writes_artifact_after_separation(self):
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

            transcription_path = output_dir / "data" / "transcription.json"
            self.assertTrue(transcription_path.exists())

            with transcription_path.open("r", encoding="utf-8") as file_obj:
                payload = json.load(file_obj)

            self.assertIsInstance(payload.get("segments"), list)


if __name__ == "__main__":
    unittest.main()
