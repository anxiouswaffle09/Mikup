import os
import re
import logging
import platform

import librosa
import numpy as np
import onnxruntime as ort
import soundfile as sf
from audio_separator.separator import Separator

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class MikupSeparator:
    """
    Surgical Audio Separation for Project Mikup.
    Produces a 5-stem technical split:
      1) dialogue
      2) music
      3) foley
      4) sfx
      5) ambience
    """

    def __init__(self, output_dir="data/processed"):
        self.output_dir = os.path.abspath(output_dir)
        os.makedirs(self.output_dir, exist_ok=True)
        self.separator = self._build_separator()
        self._semantic_tagger = None

    def _build_separator(self):
        """Instantiate audio-separator with best-effort provider/output-dir options."""
        try:
            separator = Separator(output_dir=self.output_dir)
            if (
                platform.system() == "Darwin"
                and "CoreMLExecutionProvider" in ort.get_available_providers()
            ):
                separator.onnx_execution_provider = ["CoreMLExecutionProvider"]
                logger.info("Reinforced CoreMLExecutionProvider for audio separation.")
            return separator
        except Exception as exc:
            logger.warning("Failed to initialize Separator with output_dir: %s. Falling back to defaults.", exc)
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

            self._semantic_tagger = MikupSemanticTagger()
            return self._semantic_tagger
        except Exception as exc:
            logger.warning("Unable to initialize semantic tagger for secondary split: %s", exc)
            self._semantic_tagger = False
            return None

    @staticmethod
    def _semantic_bias(tags):
        sfx_keywords = {"gunshots", "explosions", "beeps", "electronic"}
        ambience_keywords = {"rain", "birds", "traffic", "tavern", "wind", "silence", "ocean"}

        sfx_score = 0.0
        ambience_score = 0.0
        for tag in tags or []:
            if not isinstance(tag, dict):
                continue
            label = str(tag.get("label", "")).lower()
            score = float(tag.get("score", 0.0) or 0.0)
            if any(keyword in label for keyword in sfx_keywords):
                sfx_score += score
            if any(keyword in label for keyword in ambience_keywords):
                ambience_score += score

        sfx_score = float(np.clip(sfx_score, 0.0, 1.0))
        ambience_score = float(np.clip(ambience_score, 0.0, 1.0))
        return sfx_score, ambience_score

    def _split_other_stem(self, other_stem, source_base, fast_mode=False):
        if not other_stem or not os.path.exists(other_stem):
            return None, None, None

        tags = []
        if not fast_mode:
            tagger = self._get_semantic_tagger()
            if tagger:
                try:
                    tags = tagger.tag_audio(other_stem)
                    logger.info("Secondary split semantic tags: %s", tags)
                except Exception as exc:
                    logger.warning("Secondary semantic tagging failed: %s", exc)

        sfx_bias, ambience_bias = self._semantic_bias(tags)
        cutoff_percentile = float(np.clip(65.0 - (20.0 * sfx_bias) + (20.0 * ambience_bias), 40.0, 85.0))

        audio, sr = self._load_audio(other_stem, target_sr=None)
        foley_channels = []
        sfx_channels = []
        ambience_channels = []

        for channel in audio:
            stft = librosa.stft(channel, n_fft=2048, hop_length=512)
            harmonic, percussive = librosa.decompose.hpss(stft)

            percussive_mag = np.abs(percussive)
            centroid = librosa.feature.spectral_centroid(S=percussive_mag, sr=sr)[0]
            if centroid.size == 0:
                centroid = np.zeros(percussive.shape[1], dtype=np.float32)

            cutoff = np.percentile(centroid, cutoff_percentile) if centroid.size else 0.0
            sfx_mask_1d = (centroid >= cutoff).astype(np.float32)
            sfx_mask = np.broadcast_to(sfx_mask_1d[np.newaxis, :], percussive.shape)

            percussive_sfx = percussive * sfx_mask
            percussive_foley = percussive - percussive_sfx

            channel_foley = librosa.istft(percussive_foley, hop_length=512, length=channel.shape[0])
            channel_sfx = librosa.istft(percussive_sfx, hop_length=512, length=channel.shape[0])
            channel_ambience = librosa.istft(harmonic, hop_length=512, length=channel.shape[0])

            foley_channels.append(channel_foley)
            sfx_channels.append(channel_sfx)
            ambience_channels.append(channel_ambience)

        foley_audio = np.vstack(foley_channels)
        sfx_audio = np.vstack(sfx_channels)
        ambience_audio = np.vstack(ambience_channels)

        sfx_gain = float(np.clip(1.0 + 0.5 * (sfx_bias - ambience_bias), 0.6, 1.6))
        ambience_gain = float(np.clip(1.0 + 0.5 * (ambience_bias - sfx_bias), 0.6, 1.6))
        sfx_audio *= sfx_gain
        ambience_audio *= ambience_gain

        foley_path = os.path.join(self.output_dir, f"{source_base}_Foley.wav")
        sfx_path = os.path.join(self.output_dir, f"{source_base}_SFX.wav")
        ambience_path = os.path.join(self.output_dir, f"{source_base}_Ambience.wav")

        return (
            self._write_audio(foley_path, foley_audio, sr),
            self._write_audio(sfx_path, sfx_audio, sr),
            self._write_audio(ambience_path, ambience_audio, sr),
        )

    def separate_multi_stem(self, input_file):
        """
        Pass 1: Core 4-stem decomposition using htdemucs family.
        """
        logger.info("Starting Pass 1: Core 4-stem split (htdemucs)...")
        self._load_model_with_fallback([
            "htdemucs_ft.yaml",
            "htdemucs.yaml",
            "htdemucs_6s.yaml",
            "htdemucs",
        ])
        output_files = self._separate(input_file)
        logger.info("Pass 1 complete. Stems generated: %s", output_files)
        return output_files

    def separate_dialogue(self, input_file):
        """
        Fallback dialogue split for environments without htdemucs artifacts.
        """
        logger.info("Fallback Pass: Dialogue split via Roformer.")
        self._load_model_with_fallback([
            "mel_band_roformer_kim_ft_unwa.ckpt",
            "UVR_MDXNET_KARA_2.onnx",
        ])
        output_files = self._separate(input_file)
        logger.info("Fallback dialogue split complete. Stems generated: %s", output_files)
        return output_files

    def dereverb_dialogue(self, dialogue_file):
        logger.info("Starting dialogue de-reverb pass...")
        self._load_model_with_fallback([
            "dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt",
            "UVR-DeEcho-DeReverb.pth",
        ])
        output_files = self._separate(dialogue_file)
        logger.info("De-reverb pass complete. Stems generated: %s", output_files)
        return output_files

    def run_surgical_pipeline(self, input_file, fast_mode=False):
        """
        Runs Mikup Stage 1 surgical separation with 5-stem output.
        """
        source_base = os.path.splitext(os.path.basename(input_file))[0] or "source"

        try:
            primary_stems = self.separate_multi_stem(input_file) or []
        except Exception as exc:
            logger.warning("4-stem htdemucs pass failed: %s", exc)
            primary_stems = self.separate_dialogue(input_file) or []

        dialogue_stem = self._pick_stem(primary_stems, required_tokens={"vocals"})
        drums_stem = self._pick_stem(primary_stems, required_tokens={"drums"})
        bass_stem = self._pick_stem(primary_stems, required_tokens={"bass"})
        other_stem = self._pick_stem(primary_stems, required_tokens={"other"})

        if dialogue_stem is None:
            dialogue_stem = self._pick_stem(primary_stems, required_tokens={"dialogue"})

        music_path = os.path.join(self.output_dir, f"{source_base}_Music.wav")
        music_stem = self._mix_stems([drums_stem, bass_stem], music_path)

        if music_stem is None:
            instrumental = (
                self._pick_stem(primary_stems, required_tokens={"instrumental"})
                or self._pick_stem(primary_stems, required_tokens={"accompaniment"})
                or self._pick_stem(primary_stems, required_tokens={"no", "vocals"})
            )
            music_stem = instrumental

        foley_stem, sfx_stem, ambience_stem = self._split_other_stem(
            other_stem,
            source_base=source_base,
            fast_mode=fast_mode,
        )

        if foley_stem is None and drums_stem:
            fallback_foley = os.path.join(self.output_dir, f"{source_base}_Foley.wav")
            foley_stem = self._mix_stems([drums_stem], fallback_foley)

        if ambience_stem is None and other_stem:
            fallback_ambience = os.path.join(self.output_dir, f"{source_base}_Ambience.wav")
            ambience_stem = self._mix_stems([other_stem], fallback_ambience)

        background_path = os.path.join(self.output_dir, f"{source_base}_Background.wav")
        background_stem = self._mix_stems(
            [music_stem, foley_stem, sfx_stem, ambience_stem],
            background_path,
        )
        if background_stem is None:
            background_stem = (
                self._pick_stem(primary_stems, required_tokens={"instrumental"})
                or other_stem
                or music_stem
            )

        results = {
            "dialogue_raw": dialogue_stem,
            "background_raw": background_stem,
            "dialogue_dry": None,
            "reverb_tail": None,
            "music": music_stem,
            "foley": foley_stem,
            "sfx": sfx_stem,
            "ambience": ambience_stem,
        }

        if dialogue_stem and not fast_mode:
            reverb_stems = self.dereverb_dialogue(dialogue_stem) or []
            results["dialogue_dry"] = (
                self._pick_stem(reverb_stems, required_tokens={"no", "reverb"})
                or self._pick_stem(reverb_stems, required_tokens={"vocals"}, forbidden_tokens={"reverb"})
            )
            results["reverb_tail"] = self._pick_stem(
                reverb_stems,
                required_tokens={"reverb"},
                forbidden_tokens={"no"},
            )
        elif fast_mode:
            logger.info("Fast mode enabled: skipping de-reverb pass.")

        return results


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1:
        msep = MikupSeparator()
        print(msep.run_surgical_pipeline(sys.argv[1]))
