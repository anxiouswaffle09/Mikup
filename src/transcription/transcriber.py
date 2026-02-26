import logging
import json
import os

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

try:
    import whisperx
except ImportError:
    whisperx = None

class MikupTranscriber:
    """
    Handles transcription, word-level alignment, and speaker diarization.
    Focuses on 'Pacing Mikups' (inter-line gaps).
    """
    
    def __init__(self, device="cpu", compute_type="int8"):
        self.device = device
        self.compute_type = compute_type
        self.model = None
        if whisperx is None:
            logger.warning(
                "whisperx is not installed; Stage 2 transcription will be skipped."
            )

    def _require_whisperx(self):
        if whisperx is None:
            raise RuntimeError(
                "whisperx dependency is missing. Install whisperx in a compatible environment to enable Stage 2."
            )
        return whisperx

    def load_model(self, model_size="base"):
        wx = self._require_whisperx()
        logger.info(f"Loading WhisperX model: {model_size}...")
        self.model = wx.load_model(model_size, self.device, compute_type=self.compute_type)

    def transcribe(self, audio_path, batch_size=16):
        """
        Transcribe audio and align it to get word-level timestamps.
        """
        if self.model is None:
            self.load_model()

        wx = self._require_whisperx()
        logger.info(f"Transcribing: {audio_path}")
        audio = wx.load_audio(audio_path)
        result = self.model.transcribe(audio, batch_size=batch_size)

        # 2. Align whisper output
        logger.info("Aligning transcription...")
        model_a, metadata = wx.load_align_model(language_code=result["language"], device=self.device)
        result = wx.align(result["segments"], model_a, metadata, audio, self.device, return_char_alignments=False)

        return result

    def diarize(self, audio_path, transcription_result, hf_token=None):
        """
        Assign speaker labels to the aligned segments.
        Requires HF_TOKEN for pyannote.audio.
        """
        if not hf_token:
            logger.warning("HF_TOKEN not provided. Skipping diarization.")
            return transcription_result

        wx = self._require_whisperx()
        logger.info("Starting Diarization...")
        diarize_model = wx.DiarizationPipeline(use_auth_token=hf_token, device=self.device)
        diarize_segments = diarize_model(audio_path)
        
        result = wx.assign_word_speakers(diarize_segments, transcription_result)
        return result

    def save_results(self, result, output_path):
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
        logger.info(f"Transcription results saved to {output_path}")
