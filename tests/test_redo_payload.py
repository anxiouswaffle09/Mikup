import json
import tempfile
import types
import unittest
from pathlib import Path

from tests._pipeline_test_utils import load_main_module, run_main


def _read_json(path: Path):
    with path.open("r", encoding="utf-8") as file_obj:
        return json.load(file_obj)


def _write_json(path: Path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as file_obj:
        json.dump(payload, file_obj, indent=2)


class RedoInvalidationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.main_module = load_main_module()

    def test_redo_transcription_keeps_non_dependent_stages(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir) / "workspace"
            artifacts = self.main_module._artifact_paths(str(output_dir))
            stage_state = {
                "stages": {
                    stage: {"completed": True, "timestamp": "2026-03-01T00:00:00"}
                    for stage in ("separation", "transcription", "dsp", "semantics", "director")
                }
            }

            invalidated = self.main_module._invalidate_redo_stages(
                types.SimpleNamespace(redo_stage="transcription"),
                str(output_dir),
                artifacts,
                stage_state,
            )

            self.assertEqual(invalidated, {"transcription", "semantics", "director"})
            self.assertIn("separation", stage_state["stages"])
            self.assertIn("dsp", stage_state["stages"])
            self.assertNotIn("transcription", stage_state["stages"])
            self.assertNotIn("semantics", stage_state["stages"])
            self.assertNotIn("director", stage_state["stages"])

    def test_redo_separation_invalidates_all_dependent_stages(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir) / "workspace"
            artifacts = self.main_module._artifact_paths(str(output_dir))
            stage_state = {
                "stages": {
                    stage: {"completed": True, "timestamp": "2026-03-01T00:00:00"}
                    for stage in ("separation", "transcription", "dsp", "semantics", "director")
                }
            }

            invalidated = self.main_module._invalidate_redo_stages(
                types.SimpleNamespace(redo_stage="separation"),
                str(output_dir),
                artifacts,
                stage_state,
            )

            self.assertEqual(
                invalidated,
                {"separation", "transcription", "semantics", "director"},
            )
            self.assertIn("dsp", stage_state["stages"])
            for stage in ("separation", "transcription", "semantics", "director"):
                self.assertNotIn(stage, stage_state["stages"])


class RedoPayloadMergeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.main_module = load_main_module()

    def test_redo_transcription_preserves_dsp_and_invalidates_semantics(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir) / "workspace"
            payload_path = output_dir / "mikup_payload.json"
            data_dir = output_dir / "data"

            run_main(
                self.main_module,
                ["--input", "dummy.wav", "--mock", "--output-dir", str(output_dir)],
            )

            _write_json(
                data_dir / "dsp_metrics.json",
                {
                    "spatial_metrics": {"total_duration": 321.0},
                    "lufs_graph": {"DX": {"integrated": -18.5}},
                    "diagnostic_meters": {
                        "stereo_correlation": 0.9,
                        "stereo_balance": 0.1,
                    },
                },
            )
            _write_json(
                data_dir / "semantics.json",
                [{"label": "rain", "score": 0.92}],
            )
            _write_json(
                data_dir / "transcription.json",
                {
                    "segments": [{"start": 0.0, "end": 1.0, "text": "old"}],
                    "pacing_mikups": [{"timestamp": 0.5, "duration_ms": 300}],
                },
            )

            stage_state_before = _read_json(data_dir / "stage_state.json")
            dsp_timestamp_before = stage_state_before["stages"]["dsp"]["timestamp"]
            transcription_timestamp_before = stage_state_before["stages"]["transcription"]["timestamp"]

            seeded_payload = _read_json(payload_path)
            seeded_payload["metadata"]["stage_timestamps"] = {
                "separation": stage_state_before["stages"]["separation"]["timestamp"],
                "transcription": transcription_timestamp_before,
                "dsp": dsp_timestamp_before,
                "semantics": stage_state_before["stages"]["semantics"]["timestamp"],
            }
            _write_json(payload_path, seeded_payload)

            run_main(
                self.main_module,
                [
                    "--input",
                    "dummy.wav",
                    "--mock",
                    "--output-dir",
                    str(output_dir),
                    "--redo-stage",
                    "transcription",
                ],
            )

            updated_payload = _read_json(payload_path)
            stage_timestamps = updated_payload["metadata"]["stage_timestamps"]

            self.assertEqual(updated_payload["transcription"]["segments"], [])
            self.assertEqual(updated_payload["metrics"]["spatial_metrics"]["total_duration"], 321.0)
            self.assertEqual(updated_payload["metrics"]["lufs_graph"]["DX"]["integrated"], -18.5)
            self.assertEqual(updated_payload["semantics"]["background_tags"], [])
            self.assertEqual(stage_timestamps["dsp"], dsp_timestamp_before)
            self.assertNotEqual(stage_timestamps["transcription"], transcription_timestamp_before)
            self.assertIn("semantics", stage_timestamps)
            self.assertTrue(updated_payload["is_complete"])


if __name__ == "__main__":
    unittest.main()
