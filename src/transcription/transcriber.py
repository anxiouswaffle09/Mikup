import logging
import json
import os

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Project-local model directory (populated by scripts/download_models.py)
_MODELS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "models",
)


def _detect_devices():
    """Auto-detect best available compute device for each engine.

    Returns:
        ct2_device   — faster-whisper/CTranslate2 device ("cpu" or "cuda")
        ct2_compute  — CTranslate2 compute type ("int8" or "float16")
        torch_device — PyTorch device string for pyannote ("cpu", "cuda", "mps")
    """
    import torch
    if torch.cuda.is_available():
        return "cuda", "float16", "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        # CTranslate2 has no MPS backend — faster-whisper must use CPU.
        # pyannote (pure PyTorch) can use MPS.
        return "cpu", "int8", "mps"
    return "cpu", "int8", "cpu"


class MikupTranscriber:
    """
    Stage 2: Transcription and Speaker Diarization.
    Uses faster-whisper for transcription (word timestamps included)
    and pyannote.audio for speaker diarization.
    Same public API as the previous whisperx-based implementation.
    """

    def __init__(self, model_size="small"):
        self.model_size = model_size
        self.ct2_device, self.ct2_compute, self.torch_device = _detect_devices()
        logger.info(
            "MikupTranscriber: faster-whisper on %s/%s, pyannote on %s",
            self.ct2_device, self.ct2_compute, self.torch_device,
        )

    @staticmethod
    def _assign_speaker(seg_start, seg_end, diarization):
        """Return the speaker label with the most overlap in [seg_start, seg_end]."""
        speaker_overlap = {}
        for turn, _, speaker in diarization.itertracks(yield_label=True):
            overlap = min(seg_end, turn.end) - max(seg_start, turn.start)
            if overlap > 0:
                speaker_overlap[speaker] = speaker_overlap.get(speaker, 0) + overlap
        if not speaker_overlap:
            return "UNKNOWN"
        return max(speaker_overlap, key=speaker_overlap.get)

    def transcribe(self, audio_path, batch_size=16):
        """
        Transcribe audio using faster-whisper with word-level timestamps.
        batch_size is accepted for API compatibility but not used.

        Returns:
            {
                "segments":      [{start, end, text, speaker: "UNKNOWN"}, ...],
                "word_segments": [{word, start, end}, ...]
            }
        """
        from faster_whisper import WhisperModel

        local_path = os.path.join(_MODELS_DIR, "whisper-small")
        model_id = local_path if os.path.exists(os.path.join(local_path, "model.bin")) else self.model_size
        logger.info(
            "Loading WhisperModel (%s) on %s / %s...",
            model_id, self.ct2_device, self.ct2_compute,
        )
        model = WhisperModel(
            model_id,
            device=self.ct2_device,
            compute_type=self.ct2_compute,
        )

        logger.info("Transcribing: %s", audio_path)
        fw_segments, _ = model.transcribe(audio_path, word_timestamps=True)

        segments = []
        word_segments = []

        for seg in fw_segments:
            segments.append({
                "start": seg.start,
                "end": seg.end,
                "text": seg.text.strip(),
                "speaker": "UNKNOWN",
            })
            if seg.words:
                for w in seg.words:
                    word_segments.append({
                        "word": w.word,
                        "start": w.start,
                        "end": w.end,
                    })

        logger.info(
            "Transcription complete: %d segments, %d words.",
            len(segments), len(word_segments),
        )
        return {"segments": segments, "word_segments": word_segments}

    def diarize(self, audio_path, transcription_result, hf_token=None):
        """
        Assign speaker labels to segments using pyannote/speaker-diarization-3.1.
        If hf_token is absent or the pipeline fails, returns result unchanged
        (segments keep speaker: "UNKNOWN").
        """
        if not hf_token:
            logger.warning("HF_TOKEN not provided. Skipping diarization.")
            return transcription_result

        try:
            from pyannote.audio import Pipeline
            import torch

            logger.info(
                "Loading pyannote diarization pipeline on %s...", self.torch_device
            )
            pipeline = Pipeline.from_pretrained(
                "pyannote/speaker-diarization-3.1",
                use_auth_token=hf_token,
            )
            pipeline.to(torch.device(self.torch_device))

            logger.info("Running diarization on: %s", audio_path)
            diarization = pipeline(audio_path)

            for segment in transcription_result.get("segments", []):
                segment["speaker"] = self._assign_speaker(
                    segment["start"], segment["end"], diarization
                )

            logger.info("Diarization complete.")

        except Exception as exc:
            logger.warning(
                "Diarization failed (%s: %s) — continuing with UNKNOWN speakers.",
                type(exc).__name__, exc,
            )

        return transcription_result

    def save_results(self, result, output_path):
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
        logger.info("Transcription results saved to %s", output_path)
