import importlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.modules.pop("src.transcription.transcriber", None)
MikupTranscriber = importlib.import_module("src.transcription.transcriber").MikupTranscriber

from tests._pipeline_test_utils import load_main_module, run_main


class FallbackSpeakerAssignmentTests(unittest.TestCase):
    def test_apply_fallback_speakers_reuses_label_for_same_unknown_identity(self):
        payload = {
            "segments": [
                {"speaker": "UNKNOWN_0", "text": "a"},
                {"speaker": "UNKNOWN_1", "text": "b"},
                {"speaker": "UNKNOWN_0", "text": "c"},
                {"speaker": "SPEAKER_01", "text": "d"},
            ]
        }

        result = MikupTranscriber._apply_fallback_speakers(payload)
        speakers = [segment["speaker"] for segment in result["segments"]]

        self.assertEqual(speakers[0], "Speaker 1")
        self.assertEqual(speakers[1], "Speaker 2")
        self.assertEqual(speakers[2], "Speaker 1")
        self.assertEqual(speakers[3], "SPEAKER_01")

    def test_apply_fallback_speakers_groups_blank_and_unknown(self):
        payload = {
            "segments": [
                {"speaker": None, "text": "a"},
                {"speaker": "", "text": "b"},
                {"speaker": "UNKNOWN", "text": "c"},
            ]
        }

        result = MikupTranscriber._apply_fallback_speakers(payload)
        speakers = [segment["speaker"] for segment in result["segments"]]

        self.assertEqual(speakers, ["Speaker 1", "Speaker 1", "Speaker 1"])

    def test_apply_fallback_speakers_respects_existing_generic_labels(self):
        payload = {
            "segments": [
                {"speaker": "Speaker 1", "text": "already tagged"},
                {"speaker": "UNKNOWN", "text": "needs fallback"},
            ]
        }

        result = MikupTranscriber._apply_fallback_speakers(payload)
        speakers = [segment["speaker"] for segment in result["segments"]]

        self.assertEqual(speakers, ["Speaker 1", "Speaker 2"])


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
