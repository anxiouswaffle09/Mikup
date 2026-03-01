import logging
import json
import os
import platform
import inspect
import tempfile

import librosa
import numpy as np

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
        ct2_device   - faster-whisper/CTranslate2 device ("cpu" or "cuda")
        ct2_compute  - CTranslate2 compute type ("int8" or "float16")
        torch_device - PyTorch device string for pyannote ("cpu", "cuda", "mps")
    """
    import torch
    if torch.cuda.is_available():
        return "cuda", "float16", "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        # CTranslate2 has no MPS backend - faster-whisper must use CPU.
        # pyannote (pure PyTorch) can use MPS.
        return "cpu", "int8", "mps"
    return "cpu", "int8", "cpu"


class MikupTranscriber:
    """
    Stage 2: Transcription and Speaker Diarization.
    Uses faster-whisper by default, with optional mlx-whisper on Apple Silicon.
    """

    def __init__(self, model_size="small", prefer_mlx=True):
        self.model_size = model_size
        self.prefer_mlx = prefer_mlx
        self.apple_silicon = platform.system() == "Darwin" and platform.machine() == "arm64"
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
            return "Dialogue"
        return max(speaker_overlap, key=speaker_overlap.get)

    @staticmethod
    def _apply_fallback_speakers(transcription_result):
        """Replace missing/UNKNOWN speaker tags with clean generic labels."""
        segments = transcription_result.get("segments", [])
        if not isinstance(segments, list):
            return transcription_result

        fallback_index = 1
        for segment in segments:
            if not isinstance(segment, dict):
                continue
            speaker = str(segment.get("speaker") or "").strip()
            if speaker and speaker.upper() != "UNKNOWN":
                continue
            segment["speaker"] = f"Speaker {fallback_index}"
            fallback_index += 1

        return transcription_result

    @staticmethod
    def _build_pacing_mikups(transcription_result, min_gap_seconds=0.1):
        """Create pacing events for silence gaps between adjacent transcript segments."""
        if not isinstance(transcription_result, dict):
            return []

        segments = transcription_result.get("segments", [])
        if not isinstance(segments, list):
            return []

        normalized_segments = []
        for segment in segments:
            if not isinstance(segment, dict):
                continue
            start = MikupTranscriber._safe_float(segment.get("start"), None)
            end = MikupTranscriber._safe_float(segment.get("end"), None)
            if start is None or end is None:
                continue
            if end < start:
                continue
            normalized_segments.append((start, end, segment))

        if len(normalized_segments) < 2:
            return []

        normalized_segments.sort(key=lambda item: item[0])
        pacing_mikups = []
        for previous, current in zip(normalized_segments, normalized_segments[1:]):
            previous_end = previous[1]
            current_start = current[0]
            gap_seconds = current_start - previous_end
            if gap_seconds <= min_gap_seconds:
                continue

            previous_speaker = str(previous[2].get("speaker") or "Dialogue").strip() or "Dialogue"
            current_speaker = str(current[2].get("speaker") or "Dialogue").strip() or "Dialogue"
            pacing_mikups.append({
                "timestamp": previous_end,
                "duration_ms": int(round(gap_seconds * 1000.0)),
                "context": f"Between [{previous_speaker}] and [{current_speaker}]",
            })

        return pacing_mikups

    def _attach_pacing_mikups(self, transcription_result):
        if not isinstance(transcription_result, dict):
            return transcription_result
        transcription_result["pacing_mikups"] = self._build_pacing_mikups(transcription_result)
        return transcription_result

    def _mlx_model_ref(self):
        local_path = os.path.join(_MODELS_DIR, f"whisper-{self.model_size}-mlx")
        if os.path.isdir(local_path):
            return local_path

        known_models = {
            "tiny": "mlx-community/whisper-tiny-mlx",
            "base": "mlx-community/whisper-base-mlx",
            "small": "mlx-community/whisper-small-mlx",
            "medium": "mlx-community/whisper-medium-mlx",
            "large": "mlx-community/whisper-large-v3-mlx",
            "large-v3": "mlx-community/whisper-large-v3-mlx",
        }
        return known_models.get(self.model_size, "mlx-community/whisper-small-mlx")

    @staticmethod
    def _safe_float(value, default=0.0):
        try:
            return float(value)
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _merge_intervals(intervals, max_gap=0.15):
        if not intervals:
            return []

        merged = [list(intervals[0])]
        for start, end in intervals[1:]:
            if start - merged[-1][1] <= max_gap:
                merged[-1][1] = max(merged[-1][1], end)
            else:
                merged.append([start, end])
        return [(start, end) for start, end in merged]

    def _detect_speech_intervals(self, audio_path, fast_mode=False):
        """
        Lightweight VAD pass to skip silence-heavy regions before ASR.
        Returns (intervals_in_seconds, mono_audio_16k, sample_rate) or (None, None, None) on failure.
        """
        try:
            y, sr = librosa.load(audio_path, sr=16000, mono=True)
        except Exception as exc:
            logger.warning(
                "VAD pre-pass failed (%s: %s). Falling back to full-audio transcription.",
                type(exc).__name__,
                exc,
            )
            return None, None, None

        if y.size == 0:
            return [], y, sr

        top_db = 25 if fast_mode else 30
        min_speech_seconds = 0.5 if fast_mode else 0.2
        raw_intervals = librosa.effects.split(
            y,
            top_db=top_db,
            frame_length=1024,
            hop_length=256,
        )

        speech_intervals = []
        for start_idx, end_idx in raw_intervals:
            start = start_idx / sr
            end = end_idx / sr
            if (end - start) >= min_speech_seconds:
                speech_intervals.append((start, end))

        speech_intervals = self._merge_intervals(
            speech_intervals,
            max_gap=0.10 if fast_mode else 0.15,
        )
        return speech_intervals, y, sr

    def _normalize_transcription_payload(self, payload, engine_name, time_offset=0.0):
        if not isinstance(payload, dict):
            raise ValueError(f"{engine_name} returned non-dict payload")

        raw_segments = payload.get("segments")
        if not isinstance(raw_segments, list):
            raise ValueError(f"{engine_name} payload missing segments list")

        segments = []
        word_segments = []

        for segment in raw_segments:
            if not isinstance(segment, dict):
                continue

            start = self._safe_float(segment.get("start"), 0.0) + time_offset
            end = self._safe_float(segment.get("end"), (start - time_offset) + 0.5) + time_offset
            text = str(segment.get("text") or "").strip()

            segments.append({
                "start": start,
                "end": end,
                "text": text,
                "speaker": "Dialogue",
            })

            words = segment.get("words")
            if isinstance(words, list):
                for word in words:
                    if not isinstance(word, dict):
                        continue
                    token = str(word.get("word") or "").strip()
                    if not token:
                        continue
                    word_segments.append({
                        "word": token,
                        "start": self._safe_float(word.get("start"), start - time_offset) + time_offset,
                        "end": self._safe_float(word.get("end"), end - time_offset) + time_offset,
                    })

        logger.info(
            "%s transcription complete: %d segments, %d words.",
            engine_name,
            len(segments),
            len(word_segments),
        )
        return {"segments": segments, "word_segments": word_segments}

    def _mlx_transcribe_kwargs(self, transcribe_fn, model_ref):
        kwargs = {"word_timestamps": True}
        try:
            signature = inspect.signature(transcribe_fn)
            if "path_or_hf_repo" in signature.parameters:
                kwargs["path_or_hf_repo"] = model_ref
            elif "model" in signature.parameters:
                kwargs["model"] = model_ref
            elif "model_path" in signature.parameters:
                kwargs["model_path"] = model_ref
            elif "repo_id" in signature.parameters:
                kwargs["repo_id"] = model_ref
            if "verbose" in signature.parameters:
                kwargs["verbose"] = False
        except (TypeError, ValueError):
            kwargs["path_or_hf_repo"] = model_ref
        return kwargs

    @staticmethod
    def _slice_audio_chunk(audio_data, sample_rate, start_sec, end_sec):
        start_idx = max(0, int(start_sec * sample_rate))
        end_idx = min(audio_data.shape[0], int(end_sec * sample_rate))
        if end_idx <= start_idx:
            return np.array([], dtype=np.float32)
        return audio_data[start_idx:end_idx].astype(np.float32, copy=False)

    @staticmethod
    def _call_mlx_transcribe(transcribe_fn, audio_input, kwargs, sample_rate):
        try:
            return transcribe_fn(audio_input, **kwargs)
        except Exception:
            if isinstance(audio_input, str):
                raise
            import soundfile as sf

            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp_file:
                tmp_path = tmp_file.name
            try:
                sf.write(tmp_path, audio_input, sample_rate)
                return transcribe_fn(tmp_path, **kwargs)
            finally:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)

    def _transcribe_with_mlx(
        self,
        audio_path,
        speech_intervals=None,
        speech_audio=None,
        speech_sr=16000,
    ):
        import mlx_whisper

        transcribe_fn = getattr(mlx_whisper, "transcribe", None)
        if not callable(transcribe_fn):
            raise RuntimeError("mlx_whisper.transcribe is not available")

        model_ref = self._mlx_model_ref()
        kwargs = self._mlx_transcribe_kwargs(transcribe_fn, model_ref)

        if speech_intervals is not None and speech_audio is not None:
            logger.info(
                "Transcribing %d VAD speech segment(s) with mlx-whisper (%s).",
                len(speech_intervals),
                model_ref,
            )
            segments = []
            word_segments = []
            for start_sec, end_sec in speech_intervals:
                chunk = self._slice_audio_chunk(speech_audio, speech_sr, start_sec, end_sec)
                if chunk.size == 0:
                    continue
                payload = self._call_mlx_transcribe(
                    transcribe_fn,
                    chunk,
                    kwargs,
                    speech_sr,
                )
                normalized = self._normalize_transcription_payload(
                    payload,
                    "mlx-whisper",
                    time_offset=start_sec,
                )
                segments.extend(normalized["segments"])
                word_segments.extend(normalized["word_segments"])
            logger.info(
                "mlx-whisper VAD transcription complete: %d segments, %d words.",
                len(segments),
                len(word_segments),
            )
            return {"segments": segments, "word_segments": word_segments}

        logger.info("Transcribing with mlx-whisper (%s): %s", model_ref, audio_path)
        payload = self._call_mlx_transcribe(
            transcribe_fn,
            audio_path,
            kwargs,
            speech_sr,
        )
        return self._normalize_transcription_payload(payload, "mlx-whisper")

    @staticmethod
    def _append_fw_segments(fw_segments, offset_seconds, segments, word_segments):
        for seg in fw_segments:
            seg_start = float(seg.start) + offset_seconds
            seg_end = float(seg.end) + offset_seconds
            segments.append({
                "start": seg_start,
                "end": seg_end,
                "text": seg.text.strip(),
                "speaker": "Dialogue",
            })
            if seg.words:
                for word in seg.words:
                    word_segments.append({
                        "word": word.word,
                        "start": float(word.start) + offset_seconds,
                        "end": float(word.end) + offset_seconds,
                    })

    @staticmethod
    def _call_fw_transcribe(model, audio_input, sample_rate):
        try:
            return model.transcribe(audio_input, word_timestamps=True)
        except Exception:
            if isinstance(audio_input, str):
                raise
            import soundfile as sf

            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp_file:
                tmp_path = tmp_file.name
            try:
                sf.write(tmp_path, audio_input, sample_rate)
                return model.transcribe(tmp_path, word_timestamps=True)
            finally:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)

    def _transcribe_with_faster_whisper(
        self,
        audio_path,
        speech_intervals=None,
        speech_audio=None,
        speech_sr=16000,
    ):
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

        segments = []
        word_segments = []

        if speech_intervals is not None and speech_audio is not None:
            logger.info(
                "Transcribing %d VAD speech segment(s) with faster-whisper.",
                len(speech_intervals),
            )
            for start_sec, end_sec in speech_intervals:
                chunk = self._slice_audio_chunk(speech_audio, speech_sr, start_sec, end_sec)
                if chunk.size == 0:
                    continue
                fw_segments, _ = self._call_fw_transcribe(model, chunk, speech_sr)
                self._append_fw_segments(fw_segments, start_sec, segments, word_segments)
        else:
            logger.info("Transcribing with faster-whisper: %s", audio_path)
            fw_segments, _ = self._call_fw_transcribe(model, audio_path, speech_sr)
            self._append_fw_segments(fw_segments, 0.0, segments, word_segments)

        logger.info(
            "faster-whisper transcription complete: %d segments, %d words.",
            len(segments),
            len(word_segments),
        )
        return {"segments": segments, "word_segments": word_segments}

    def transcribe(self, audio_path, batch_size=16, fast_mode=False):
        """
        Transcribe audio with optional mlx-whisper path on Apple Silicon.
        batch_size is accepted for API compatibility but not used.
        """
        del batch_size

        speech_intervals = None
        speech_audio = None
        speech_sr = 16000

        if os.path.exists(audio_path):
            speech_intervals, speech_audio, speech_sr = self._detect_speech_intervals(
                audio_path,
                fast_mode=fast_mode,
            )
            if speech_intervals is not None:
                logger.info("VAD detected %d speech segment(s).", len(speech_intervals))
                if not speech_intervals:
                    logger.info("VAD detected no speech; returning empty transcription.")
                    return {"segments": [], "word_segments": [], "pacing_mikups": []}
        else:
            logger.warning(
                "Audio path %s does not exist at VAD pre-pass time; using direct transcription path.",
                audio_path,
            )

        if self.prefer_mlx and self.apple_silicon and self.torch_device == "mps":
            try:
                result = self._transcribe_with_mlx(
                    audio_path,
                    speech_intervals=speech_intervals,
                    speech_audio=speech_audio,
                    speech_sr=speech_sr,
                )
                result = self._apply_fallback_speakers(result)
                return self._attach_pacing_mikups(result)
            except Exception as exc:
                logger.warning(
                    "mlx-whisper path failed (%s: %s). Falling back to faster-whisper.",
                    type(exc).__name__,
                    exc,
                )

        result = self._transcribe_with_faster_whisper(
            audio_path,
            speech_intervals=speech_intervals,
            speech_audio=speech_audio,
            speech_sr=speech_sr,
        )
        result = self._apply_fallback_speakers(result)
        return self._attach_pacing_mikups(result)

    def _coerce_diarization_pipeline_dtype(self, pipeline, torch_module):
        if self.torch_device != "mps":
            return

        converted = False
        for candidate in [pipeline, getattr(pipeline, "model", None), getattr(pipeline, "_model", None)]:
            if candidate is None or not hasattr(candidate, "to"):
                continue
            try:
                candidate.to(dtype=torch_module.float16)
                converted = True
            except Exception:
                continue

        if converted:
            logger.info("Diarization model forced to float16 for MPS.")
        else:
            logger.warning("Unable to force diarization model to float16 on MPS; continuing as-is.")

    def diarize(self, audio_path, transcription_result, hf_token=None):
        """
        Assign speaker labels to segments using pyannote/speaker-diarization-3.1.
        If hf_token is absent or the pipeline fails, returns result unchanged
        with fallback labels preserved.
        """
        if not hf_token:
            logger.warning("HF_TOKEN not provided. Skipping diarization.")
            transcription_result = self._apply_fallback_speakers(transcription_result)
            return self._attach_pacing_mikups(transcription_result)

        try:
            from pyannote.audio import Pipeline
            import torch

            logger.info(
                "Loading pyannote diarization pipeline on %s...", self.torch_device
            )
            pipeline = Pipeline.from_pretrained(
                "pyannote/speaker-diarization-3.1",
                use_auth_token=hf_token,
                cache_dir=os.path.join(_MODELS_DIR, "pyannote"),
            )
            pipeline.to(torch.device(self.torch_device))
            self._coerce_diarization_pipeline_dtype(pipeline, torch)

            logger.info("Running diarization on: %s", audio_path)
            diarization = pipeline(audio_path)

            for segment in transcription_result.get("segments", []):
                segment["speaker"] = self._assign_speaker(
                    segment["start"], segment["end"], diarization
                )

            logger.info("Diarization complete.")

        except Exception as exc:
            logger.warning(
                "Diarization failed (%s: %s) - continuing with fallback speaker labels.",
                type(exc).__name__, exc,
            )

        transcription_result = self._apply_fallback_speakers(transcription_result)
        return self._attach_pacing_mikups(transcription_result)

    def save_results(self, result, output_path):
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
        logger.info("Transcription results saved to %s", output_path)
