import unittest

from tests._pipeline_test_utils import load_main_module


class MetricsEnrichmentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.main_module = load_main_module()

    def test_enrich_metrics_adds_pacing_density_and_masking_alerts(self):
        metrics = {
            "lufs_graph": {
                "DX": {
                    "integrated": -18.5,
                    "momentary": [-19.0, -18.8, -18.6, -18.4],
                }
            },
            "diagnostic_meters": {
                "intelligibility_snr": [12.0, 9.2, 8.8, 11.1],
            },
        }
        transcription = {
            "segments": [
                {"start": 0.0, "end": 0.2, "text": "two words"},
                {"start": 0.2, "end": 0.4, "text": "more words"},
            ],
            "word_segments": [
                {"start": 0.0, "end": 0.1, "word": "two"},
                {"start": 0.1, "end": 0.2, "word": "words"},
                {"start": 0.2, "end": 0.3, "word": "more"},
                {"start": 0.3, "end": 0.4, "word": "words"},
            ],
            "pacing_mikups": [{"timestamp": 0.2, "duration_ms": 120}],
        }

        enriched = self.main_module._enrich_metrics_payload(metrics, transcription)

        self.assertEqual(enriched["lufs_graph"]["pacing_density"], [10.0, 10.0, 10.0, 10.0])
        self.assertEqual(
            enriched["diagnostic_meters"]["masking_alerts"],
            [{"timestamp": 0.1, "duration_ms": 200, "context": "SNR: 8.8 dB", "snr": 8.8}],
        )
        self.assertEqual(enriched["pacing_mikups"], transcription["pacing_mikups"])


if __name__ == "__main__":
    unittest.main()
