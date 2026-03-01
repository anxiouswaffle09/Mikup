import logging
import os
import platform
import re
import wave

import librosa
import numpy as np
import onnxruntime as ort
import soundfile as sf
import torch
from audio_separator.separator import Separator

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class MikupSeparator:
    """
    Cinematic 3-pass separation for Project Mikup.
    Canonical stems:
      - DX
      - Music
      - Foley
      - SFX
      - Ambience
    """

    CANONICAL_STEMS = ("DX", "Music", "Foley", "SFX", "Ambience")

    def __init__(self, output_dir="data/processed"):
        self.output_dir = os.path.abspath(output_dir)
        os.makedirs(self.output_dir, exist_ok=True)
        self.device = self._detect_torch_device()
        self.separator = self._build_separator()
        self._semantic_tagger = None

    def _detect_torch_device(self):
        system = platform.system()
        has_mps = hasattr(torch.backends, "mps") and torch.backends.mps.is_available()
        if system == "Darwin":
            return "mps" if has_mps else "cpu"
        if torch.cuda.is_available():
            return "cuda"
        return "cpu"

    def _build_separator(self):
        """Instantiate audio-separator with platform-aware provider/device hints."""
        try:
            separator = Separator(output_dir=self.output_dir)

            available_providers = ort.get_available_providers()
            logger.info("Available ONNX Runtime providers: %s", available_providers)

            # Prioritize Hardware Acceleration Providers
            providers = []
            if "CUDAExecutionProvider" in available_providers:
                providers.append("CUDAExecutionProvider")
                logger.info("Prioritizing CUDAExecutionProvider for Linux/Windows.")
            if "CoreMLExecutionProvider" in available_providers:
                providers.append("CoreMLExecutionProvider")
                logger.info("Prioritizing CoreMLExecutionProvider for Darwin (macOS).")
            
            # Always fallback to CPU
            providers.append("CPUExecutionProvider")
            
            # Update the separator instance with the best providers
            separator.onnx_execution_provider = providers

            # Best-effort torch device assignment for audio-separator wrappers.
            for attr in ("device", "torch_device"):
                if hasattr(separator, attr):
                    try:
                        # Map internal "mps" to "cpu" for libraries that don't support it directly
                        # but still use ONNX CoreML.
                        if self.device == "mps":
                            setattr(separator, attr, "cpu")
                        else:
                            setattr(separator, attr, self.device)
                    except Exception:
                        pass

            logger.info("Separator initialized using providers: %s", providers)
            return separator
        except Exception as exc:
            logger.warning(
                "Failed to initialize Separator with custom provider options: %s. Falling back to defaults.",
                exc,
            )
            return Separator()

    @staticmethod
    def _tokens_from_path(file_path):
        if not isinstance(file_path, str):
            return set()
        stem_name = os.path.splitext(os.path.basename(file_path))[0].lower()
        tokens = {token for token in re.split(r"[^a-z0-9]+", stem_name) if token}
        if "noreverb" in tokens:
            tokens.update({"no", "reverb"})
        if "no_vocals" in tokens or "novocals" in tokens:
            tokens.update({"no", "vocals"})
        return tokens

    def _pick_stem(self, stem_paths, required_tokens=None, forbidden_tokens=None):
        required_tokens = set(required_tokens or [])
        forbidden_tokens = set(forbidden_tokens or [])
        for stem_path in stem_paths or []:
            tokens = self._tokens_from_path(stem_path)
            if required_tokens and not required_tokens.issubset(tokens):
                continue
            if forbidden_tokens and forbidden_tokens.intersection(tokens):
                continue
            return stem_path
        return None

    def _normalize_stem_path(self, stem_path):
        if not isinstance(stem_path, str):
            return None
        stem_path = stem_path.strip()
        if not stem_path:
            return None

        candidates = []
        if os.path.isabs(stem_path):
            candidates.append(stem_path)
        else:
            candidates.append(os.path.join(self.output_dir, stem_path))
            candidates.append(os.path.join(self.output_dir, os.path.basename(stem_path)))
            candidates.append(os.path.abspath(stem_path))

        for candidate in candidates:
            if os.path.exists(candidate):
                return os.path.abspath(candidate)

        return os.path.abspath(os.path.join(self.output_dir, os.path.basename(stem_path)))

    def _normalize_output_paths(self, output_files):
        if isinstance(output_files, str):
            output_files = [output_files]
        if not isinstance(output_files, list):
            return []

        normalized = []
        for path in output_files:
            normalized_path = self._normalize_stem_path(path)
            if normalized_path:
                normalized.append(normalized_path)

        return normalized

    def _load_model_with_fallback(self, model_candidates):
        last_exc = None
        for model_name in model_candidates:
            try:
                self.separator.load_model(model_name)
                logger.info("Loaded separation model: %s", model_name)
                return model_name
            except Exception as exc:
                last_exc = exc
                logger.warning("Failed loading model %s: %s", model_name, exc)
        raise RuntimeError(f"Unable to load any separation model from {model_candidates}: {last_exc}")

    def _separate(self, input_file):
        try:
            output_files = self.separator.separate(input_file)
        except Exception as exc:
            logger.warning("Standard separate() failed: %s. Trying with output_dir override.", exc)
            try:
                output_files = self.separator.separate(input_file, output_dir=self.output_dir)
            except TypeError:
                output_files = self.separator.separate(input_file)
        return self._normalize_output_paths(output_files)

    @staticmethod
    def _ensure_stereo(audio):
        if audio.ndim == 1:
            return np.vstack([audio, audio])
        return audio

    @staticmethod
    def _normalize_peak(audio, peak_target=0.98):
        peak = float(np.max(np.abs(audio))) if audio.size else 0.0
        if peak > peak_target and peak > 0:
            return (audio / peak) * peak_target
        return audio

    def _load_audio(self, path, target_sr=None):
        audio, sr = librosa.load(path, sr=target_sr, mono=False)
        audio = self._ensure_stereo(audio).astype(np.float32, copy=False)
        return audio, sr

    def _write_audio(self, path, audio, sr):
        audio = self._ensure_stereo(audio)
        audio = self._normalize_peak(audio)
        sf.write(path, audio.T, sr)
        return os.path.abspath(path)

    @staticmethod
    def _write_silent_wav(path, duration_seconds=3.0, sample_rate=22050, channels=2):
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        frame_count = max(1, int(duration_seconds * sample_rate))
        silence_frame = b"\x00\x00" * channels
        with wave.open(path, "wb") as wav_file:
            wav_file.setnchannels(channels)
            wav_file.setsampwidth(2)
            wav_file.setframerate(sample_rate)
            wav_file.writeframes(silence_frame * frame_count)
        return os.path.abspath(path)

    def _canonicalize_stem_file(self, stem_path, source_base, stem_name):
        if not stem_path or not os.path.exists(stem_path):
            return None
        canonical_path = os.path.join(self.output_dir, f"{source_base}_{stem_name}.wav")
        try:
            audio, sr = self._load_audio(stem_path, target_sr=None)
            return self._write_audio(canonical_path, audio, sr)
        except Exception as exc:
            logger.warning("Failed to canonicalize stem %s from %s: %s", stem_name, stem_path, exc)
            return os.path.abspath(stem_path)

    def _cleanup_intermediate_wavs(self, tracked_paths, keep_paths):
        tracked = {
            os.path.abspath(path)
            for path in tracked_paths
            if isinstance(path, str) and os.path.isfile(path)
        }
        keep = {
            os.path.abspath(path)
            for path in keep_paths
            if isinstance(path, str) and os.path.isfile(path)
        }
        output_dir_abs = os.path.abspath(self.output_dir)
        for candidate in tracked:
            candidate_abs = os.path.abspath(candidate)
            if not candidate_abs.startswith(output_dir_abs + os.sep):
                continue
            if not candidate.lower().endswith(".wav"):
                continue
            if candidate in keep:
                continue
            try:
                os.remove(candidate)
                logger.info("Removed intermediate stem artifact: %s", candidate)
            except OSError as exc:
                logger.warning("Failed to remove intermediate artifact %s: %s", candidate, exc)

    def _mix_stems(self, stem_paths, output_path):
        valid_paths = [path for path in stem_paths if isinstance(path, str) and os.path.exists(path)]
        if not valid_paths:
            return None

        loaded = []
        target_sr = None
        for path in valid_paths:
            audio, sr = self._load_audio(path, target_sr=None)
            if target_sr is None:
                target_sr = sr
            loaded.append((audio, sr))

        if target_sr is None:
            return None

        resampled = []
        max_len = 0
        for audio, sr in loaded:
            if sr != target_sr:
                audio = librosa.resample(audio, orig_sr=sr, target_sr=target_sr, axis=1)
            max_len = max(max_len, audio.shape[1])
            resampled.append(audio)

        mix = np.zeros((2, max_len), dtype=np.float32)
        for audio in resampled:
            if audio.shape[1] < max_len:
                audio = np.pad(audio, ((0, 0), (0, max_len - audio.shape[1])), mode="constant")
            mix += audio

        mix /= max(len(resampled), 1)
        return self._write_audio(output_path, mix, target_sr)

    def _get_semantic_tagger(self):
        if self._semantic_tagger is not None:
            return self._semantic_tagger
        try:
            from src.semantics.tagger import MikupSemanticTagger

            self._semantic_tagger = MikupSemanticTagger(device=self.device)
            return self._semantic_tagger
        except Exception as exc:
            logger.warning("Unable to initialize semantic tagger for effects split: %s", exc)
            self._semantic_tagger = False
            return None

    @staticmethod
    def _semantic_scores(tags):
        foley_keywords = {"footsteps", "rustle", "cloth"}
        sfx_keywords = {"explosion", "beep", "impact"}

        foley_score = 0.0
        sfx_score = 0.0
        for tag in tags or []:
            if not isinstance(tag, dict):
                continue
            label = str(tag.get("label", "")).lower()
            score = float(tag.get("score", 0.0) or 0.0)
            if any(keyword in label for keyword in foley_keywords):
                foley_score += score
            if any(keyword in label for keyword in sfx_keywords):
                sfx_score += score

        return float(np.clip(foley_score, 0.0, 1.0)), float(np.clip(sfx_score, 0.0, 1.0))

    def _classify_percussive_stem(self, percussive_path, fast_mode=False):
        if fast_mode:
            return 0.5, 0.5

        tagger = self._get_semantic_tagger()
        if not tagger:
            return 0.5, 0.5

        tags = []
        try:
            tags = tagger.tag_audio(
                percussive_path,
                candidate_labels=[
                    "Footsteps and cloth rustle",
                    "Explosion and hard impact",
                    "Electronic beep and alert",
                    "Soft ambient room tone",
                ],
            )
            logger.info("Pass 3 CLAP percussive tags: %s", tags)
        except Exception as exc:
            logger.warning("Pass 3 semantic classification failed: %s", exc)

        foley_score, sfx_score = self._semantic_scores(tags)
        if foley_score == 0.0 and sfx_score == 0.0:
            return 0.5, 0.5
        total = max(foley_score + sfx_score, 1e-6)
        return foley_score / total, sfx_score / total

    def _split_other_stem(self, effects_stem, source_base, fast_mode=False):
        """
        Pass 3: Effects deconstruction.
        - HPSS harmonic -> Ambience
        - HPSS percussive -> Foley/SFX via CLAP semantic routing
        """
        if not effects_stem or not os.path.exists(effects_stem):
            return None, None, None

        audio, sr = self._load_audio(effects_stem, target_sr=None)
        percussive_channels = []
        ambience_channels = []

        for channel in audio:
            stft = librosa.stft(channel, n_fft=2048, hop_length=512)
            harmonic, percussive = librosa.decompose.hpss(stft)
            percussive_channels.append(
                librosa.istft(percussive, hop_length=512, length=channel.shape[0])
            )
            ambience_channels.append(
                librosa.istft(harmonic, hop_length=512, length=channel.shape[0])
            )

        percussive_audio = np.vstack(percussive_channels)
        ambience_audio = np.vstack(ambience_channels)

        percussive_tmp_path = os.path.join(self.output_dir, f"{source_base}_Percussive.tmp.wav")
        self._write_audio(percussive_tmp_path, percussive_audio, sr)

        try:
            foley_weight, sfx_weight = self._classify_percussive_stem(
                percussive_tmp_path,
                fast_mode=fast_mode,
            )
        finally:
            if os.path.exists(percussive_tmp_path):
                try:
                    os.remove(percussive_tmp_path)
                except OSError:
                    pass

        if sfx_weight > foley_weight:
            foley_audio = np.zeros_like(percussive_audio)
            sfx_audio = percussive_audio
        elif foley_weight > sfx_weight:
            foley_audio = percussive_audio
            sfx_audio = np.zeros_like(percussive_audio)
        else:
            foley_audio = percussive_audio * 0.5
            sfx_audio = percussive_audio * 0.5

        foley_path = os.path.join(self.output_dir, f"{source_base}_Foley.wav")
        sfx_path = os.path.join(self.output_dir, f"{source_base}_SFX.wav")
        ambience_path = os.path.join(self.output_dir, f"{source_base}_Ambience.wav")

        return (
            self._write_audio(foley_path, foley_audio, sr),
            self._write_audio(sfx_path, sfx_audio, sr),
            self._write_audio(ambience_path, ambience_audio, sr),
        )

    def separate_cinematic_trinity(self, input_file):
        """
        Pass 1: Cinematic Trinity split (Dialogue, Music, Effects).
        """
        logger.info("Starting Pass 1: Cinematic Trinity (MDX-NET Cinematic 2)...")
        self._load_model_with_fallback(
            [
                "MDX-NET-Cinematic_2.onnx",
                "Cinematic_2.onnx",
                "UVR-MDX-NET-Voc_FT.onnx",
            ]
        )
        output_files = self._separate(input_file)
        logger.info("Pass 1 complete. Stems generated: %s", output_files)
        return output_files

    def refine_dialogue(self, dialogue_file):
        """
        Pass 2: Dialogue refinement via BS-Roformer-Viperx-1297.
        """
        logger.info("Starting Pass 2: Dialogue refinement (BS-Roformer-Viperx-1297)...")
        self._load_model_with_fallback(
            [
                "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
                "BS-Roformer-Viperx-1297.ckpt",
            ]
        )
        output_files = self._separate(dialogue_file)
        logger.info("Pass 2 complete. Stems generated: %s", output_files)
        return output_files

    def run_surgical_pipeline(self, input_file, fast_mode=False):
        """
        Runs the canonical 3-pass cinematic pipeline.
        Ensures 5-stem output even if Pass 1 only provides 2 stems.
        """
        source_base = os.path.splitext(os.path.basename(input_file))[0] or "source"

        # Pass 1: Cinematic Trinity
        pass1_stems = self.separate_cinematic_trinity(input_file) or []
        cleanup_candidates = set(pass1_stems)

        dialogue_stem = self._pick_stem(
            pass1_stems,
            required_tokens={"dialogue"},
        ) or self._pick_stem(
            pass1_stems,
            required_tokens={"vocals"},
        )
        music_stem = self._pick_stem(
            pass1_stems,
            required_tokens={"music"},
        ) or self._pick_stem(
            pass1_stems,
            required_tokens={"instrumental"},
        )
        effects_stem = self._pick_stem(
            pass1_stems,
            required_tokens={"effects"},
        ) or self._pick_stem(
            pass1_stems,
            required_tokens={"other"},
        )

        # Fallback: If we used a 2-stem model, "Music" contains the "Effects".
        # We use the Music stem as the source for the Pass 3 split.
        source_for_pass3 = effects_stem or music_stem

        if dialogue_stem is None:
            raise FileNotFoundError("Pass 1 did not produce a Dialogue stem.")

        # Pass 2: Dialogue Refinement
        pass2_stems = self.refine_dialogue(dialogue_stem) if not fast_mode else []
        cleanup_candidates.update(pass2_stems)
        if fast_mode:
            logger.info("Fast mode enabled: skipping Pass 2 dialogue refinement.")

        dx_stem = (
            self._pick_stem(pass2_stems, required_tokens={"dx"})
            or self._pick_stem(pass2_stems, required_tokens={"vocals"}, forbidden_tokens={"reverb", "residual"})
            or self._pick_stem(pass2_stems, required_tokens={"dialogue"}, forbidden_tokens={"residual"})
            or dialogue_stem
        )
        dx_residual = (
            self._pick_stem(pass2_stems, required_tokens={"residual"})
            or self._pick_stem(pass2_stems, required_tokens={"reverb"})
        )

        # Pass 3: Effects Deconstruction
        foley_stem, sfx_stem, ambience_stem = self._split_other_stem(
            source_for_pass3,
            source_base=source_base,
            fast_mode=fast_mode,
        )

        # Canonicalize Files
        dx_stem = self._canonicalize_stem_file(dx_stem, source_base, "DX")
        music_stem = self._canonicalize_stem_file(music_stem, source_base, "Music")
        
        if dx_residual:
            dx_residual = self._canonicalize_stem_file(dx_residual, source_base, "DX_Residual")

        # Ensure we have the full 5-stem set, even as silent fallbacks
        if not foley_stem:
            foley_stem = os.path.join(self.output_dir, f"{source_base}_Foley.wav")
            if not os.path.exists(foley_stem): self._write_silent_wav(foley_stem)
        else:
            foley_stem = self._canonicalize_stem_file(foley_stem, source_base, "Foley")

        if not sfx_stem:
            sfx_stem = os.path.join(self.output_dir, f"{source_base}_SFX.wav")
            if not os.path.exists(sfx_stem): self._write_silent_wav(sfx_stem)
        else:
            sfx_stem = self._canonicalize_stem_file(sfx_stem, source_base, "SFX")

        if not ambience_stem:
            # If we don't have ambience but we have effects_stem, use effects_stem as ambience
            if effects_stem:
                ambience_stem = self._canonicalize_stem_file(effects_stem, source_base, "Ambience")
            else:
                ambience_stem = os.path.join(self.output_dir, f"{source_base}_Ambience.wav")
                if not os.path.exists(ambience_stem): self._write_silent_wav(ambience_stem)
        else:
            ambience_stem = self._canonicalize_stem_file(ambience_stem, source_base, "Ambience")

        canonical_stems = {
            "DX": dx_stem,
            "Music": music_stem,
            "Foley": foley_stem,
            "SFX": sfx_stem,
            "Ambience": ambience_stem,
        }
        missing = [name for name, path in canonical_stems.items() if not path or not os.path.exists(path)]
        if missing:
            raise FileNotFoundError(
                f"Missing canonical stem(s) after surgical pipeline: {', '.join(missing)}"
            )

        # Cleanup: Remove intermediate Pass 1/Pass 2 artifacts.
        # We only keep the 5 canonical stems and the DX Residual tail.
        keep_for_downstream = list(canonical_stems.values())
        if dx_residual:
            keep_for_downstream.append(dx_residual)
            
        self._cleanup_intermediate_wavs(cleanup_candidates, keep_for_downstream)

        return {
            "DX": dx_stem,
            "Music": music_stem,
            "Foley": foley_stem,
            "SFX": sfx_stem,
            "Ambience": ambience_stem,
            "DX_Residual": dx_residual,
        }



if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1:
        msep = MikupSeparator()
        print(msep.run_surgical_pipeline(sys.argv[1]))
