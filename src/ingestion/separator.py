import hashlib
import logging
import os
import platform
import re
import wave
from pathlib import Path

import librosa
import numpy as np
import onnxruntime as ort
import soundfile as sf
import torch
from audio_separator.separator import Separator

try:
    from demucs.states import load_model  # noqa: F401 — enables mock patching in tests
except ImportError:
    load_model = None  # type: ignore[assignment]

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Repo root: src/ingestion/separator.py → ../../
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent


class MikupSeparator:
    """
    Hybrid cinematic separation for Project Mikup.
    Canonical stems:
      - DX       (vocals_mel_band_roformer.ckpt)
      - Music    (CDX23/Demucs4)
      - Effects  (CDX23/Demucs4)
    """

    CANONICAL_STEMS = ("DX", "Music", "Effects")
    CDX23_MODEL_IDS_HQ = [
        "97d170e1-a778de4a.th",
        "97d170e1-dbb4db15.th",
        "97d170e1-e41a5468.th",
    ]
    CDX23_MODEL_IDS_FAST = ["97d170e1-dbb4db15.th"]
    CDX23_DOWNLOAD_BASE = (
        "https://github.com/ZFTurbo/MVSEP-CDX23-Cinematic-Sound-Demixing"
        "/releases/download/v.1.0.0/"
    )
    # SHA-256 digests for CDX23 model files.
    # Pinned from verified downloads — mismatches cause deletion + RuntimeError.
    CDX23_MODEL_HASHES: dict[str, str] = {
        "97d170e1-a778de4a.th": "a778de4a72b90482a578bfb6ea6bf41462785d9136c11802c67a864a40f29434",
        "97d170e1-dbb4db15.th": "dbb4db154df7e45a5cb72d1659c48937e757f6d6b0eef8ca4199e6e38f8d8f37",
        "97d170e1-e41a5468.th": "e41a54684d3cd6794ee2bb59183ffeb11a9a3d42db873a6a08a9829ac3ef4cfe",
    }

    def __init__(self, output_dir):
        self.output_dir = str(Path(output_dir).resolve())
        Path(self.output_dir).mkdir(parents=True, exist_ok=True)
        self.device = self._detect_torch_device()
        self.separator = self._build_separator()

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
        model_file_dir = str(_REPO_ROOT / "models" / "separation")
        Path(model_file_dir).mkdir(parents=True, exist_ok=True)
        try:
            separator = Separator(
                output_dir=self.output_dir,
                model_file_dir=model_file_dir,
            )

            available_providers = ort.get_available_providers()
            logger.info("Available ONNX Runtime providers: %s", available_providers)

            providers = []
            if "CUDAExecutionProvider" in available_providers:
                providers.append("CUDAExecutionProvider")
                logger.info("Prioritizing CUDAExecutionProvider for Linux/Windows.")
            if "CoreMLExecutionProvider" in available_providers:
                providers.append("CoreMLExecutionProvider")
                logger.info("Prioritizing CoreMLExecutionProvider for Darwin (macOS).")

            providers.append("CPUExecutionProvider")
            separator.onnx_execution_provider = providers

            for attr in ("device", "torch_device"):
                if hasattr(separator, attr):
                    try:
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
            return Separator(model_file_dir=model_file_dir)

    @staticmethod
    def _tokens_from_path(file_path):
        if not isinstance(file_path, str):
            return set()
        stem_name = Path(file_path).stem.lower()
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
        if Path(stem_path).is_absolute():
            candidates.append(stem_path)
        else:
            candidates.append(str(Path(self.output_dir) / stem_path))
            candidates.append(str(Path(self.output_dir) / Path(stem_path).name))
            candidates.append(str(Path(stem_path).resolve()))

        for candidate in candidates:
            if Path(candidate).exists():
                return str(Path(candidate).resolve())

        return str((Path(self.output_dir) / Path(stem_path).name).resolve())

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
        return str(Path(path).resolve())

    @staticmethod
    def _write_silent_wav(path, duration_seconds=3.0, sample_rate=22050, channels=2):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        frame_count = max(1, int(duration_seconds * sample_rate))
        silence_frame = b"\x00\x00" * channels
        with wave.open(path, "wb") as wav_file:
            wav_file.setnchannels(channels)
            wav_file.setsampwidth(2)
            wav_file.setframerate(sample_rate)
            wav_file.writeframes(silence_frame * frame_count)
        return str(Path(path).resolve())

    def _canonicalize_stem_file(self, stem_path, source_base, stem_name):
        if not stem_path or not Path(stem_path).exists():
            return None
        canonical_path = str(Path(self.output_dir) / f"{source_base}_{stem_name}.wav")
        try:
            audio, sr = self._load_audio(stem_path, target_sr=None)
            return self._write_audio(canonical_path, audio, sr)
        except Exception as exc:
            logger.warning("Failed to canonicalize stem %s from %s: %s", stem_name, stem_path, exc)
            return str(Path(stem_path).resolve())

    def _cleanup_intermediate_wavs(self, tracked_paths, keep_paths):
        tracked = {
            str(Path(path).resolve())
            for path in tracked_paths
            if isinstance(path, str) and Path(path).is_file()
        }
        keep = {
            str(Path(path).resolve())
            for path in keep_paths
            if isinstance(path, str) and Path(path).is_file()
        }
        output_dir_abs = Path(self.output_dir).resolve()
        for candidate in tracked:
            candidate_path = Path(candidate).resolve()
            if not candidate_path.is_relative_to(output_dir_abs):
                continue
            if not candidate.lower().endswith(".wav"):
                continue
            if candidate in keep:
                continue
            try:
                Path(candidate).unlink()
                logger.info("Removed intermediate stem artifact: %s", candidate)
            except OSError as exc:
                logger.warning("Failed to remove intermediate artifact %s: %s", candidate, exc)

    @staticmethod
    def _sha256_file(path: str, chunk_size: int = 1 << 20) -> str:
        """Compute SHA-256 hex digest of a file."""
        h = hashlib.sha256()
        with open(path, "rb") as f:
            while True:
                chunk = f.read(chunk_size)
                if not chunk:
                    break
                h.update(chunk)
        return h.hexdigest()

    def _verify_model_integrity(self, model_path: str, model_id: str) -> None:
        """Verify downloaded model file against known SHA-256 hash.

        If no expected hash is registered (value is None), the computed hash is
        logged so operators can pin it on first deployment.

        Raises ``RuntimeError`` if the hash does not match.
        """
        computed = self._sha256_file(model_path)
        expected = self.CDX23_MODEL_HASHES.get(model_id)

        if expected is None:
            logger.warning(
                "No SHA-256 hash registered for CDX23 model %s. "
                "Computed hash: %s — pin this value in CDX23_MODEL_HASHES "
                "for integrity verification.",
                model_id,
                computed,
            )
            return

        if computed != expected:
            # Remove the corrupted / tampered file before raising
            try:
                Path(model_path).unlink()
            except OSError:
                pass
            raise RuntimeError(
                f"Integrity check failed for CDX23 model '{model_id}'. "
                f"Expected SHA-256 {expected}, got {computed}. "
                f"The file has been removed. Re-run to download a fresh copy."
            )

        logger.info("CDX23 model %s integrity verified (SHA-256: %s).", model_id, computed[:16] + "…")

    def _cdx23_models_dir(self):
        default_dir = str(_REPO_ROOT / "models" / "cdx23")
        env_dir = os.environ.get("MIKUP_CDX23_MODELS_DIR", "").strip()

        if env_dir:
            resolved = Path(env_dir).resolve()
            # Prevent path traversal: must not escape above repo root
            try:
                resolved.relative_to(_REPO_ROOT)
            except ValueError:
                logger.warning(
                    "MIKUP_CDX23_MODELS_DIR (%s) resolves outside the repo root (%s). "
                    "Ignoring environment override and using default.",
                    resolved,
                    _REPO_ROOT,
                )
                env_dir = ""

            # Reject suspicious components (e.g. "..", symlinks to outside)
            if env_dir and ".." in Path(env_dir).parts:
                logger.warning(
                    "MIKUP_CDX23_MODELS_DIR contains '..'. "
                    "Ignoring environment override and using default."
                )
                env_dir = ""

        base = env_dir or default_dir
        Path(base).mkdir(parents=True, exist_ok=True)
        return base

    def _pass1_mbr_vocal_split(self, input_file):
        """Pass 1: Extract vocals (DX) and instrumental via MBR."""
        logger.info("Pass 1: MBR vocal split (vocals_mel_band_roformer.ckpt)...")
        self._load_model_with_fallback(["vocals_mel_band_roformer.ckpt"])
        output_files = self._separate(input_file)
        logger.info("Pass 1 complete. Stems: %s", output_files)
        return output_files

    def _pass2_cdx23_instrumental(self, instrumental_path, source_base, fast_mode=False):
        """Pass 2: CDX23 (Demucs4/DnR) splits instrumental → music + effects."""
        import numpy as np
        import torch
        from demucs.apply import apply_model
        # load_model is imported at module level to allow mock patching in tests;
        # use the module-level binding rather than re-importing locally.

        # Guard: register HTDemucs for callers that bypass src/main.py bootstrap
        try:
            from demucs.htdemucs import HTDemucs as _HTDemucs
            torch.serialization.add_safe_globals([_HTDemucs])
        except ImportError:
            pass

        logger.info("Pass 2: CDX23 instrumental split...")
        models_dir = self._cdx23_models_dir()
        model_ids = self.CDX23_MODEL_IDS_FAST if fast_mode else self.CDX23_MODEL_IDS_HQ
        # demucs>=4.0 (Sep 2023 PyPI) supports MPS natively — complex ops fall back
        # to CPU internally, all other ops use Metal. No need to override to CPU.
        device = self.device

        if load_model is None:
            raise ImportError(
                "demucs is required for Pass 2 CDX23 separation. "
                "Install it with: pip install demucs"
            )

        models = []
        for model_id in model_ids:
            model_path = str(Path(models_dir) / model_id)
            if not Path(model_path).is_file():
                logger.info("Downloading CDX23 model: %s", model_id)
                torch.hub.download_url_to_file(
                    self.CDX23_DOWNLOAD_BASE + model_id, model_path
                )
            # Verify integrity after download (or for cached files)
            self._verify_model_integrity(model_path, model_id)
            try:
                model = load_model(model_path)
            except Exception as exc:
                raise RuntimeError(
                    f"Security gate blocked loading CDX23 model '{model_path}'. "
                    f"Ensure HTDemucs and related classes are registered via "
                    f"torch.serialization.add_safe_globals() in src/bootstrap.py. "
                    f"Original error: {exc}"
                ) from exc
            model.to(device)
            models.append(model)

        audio, sr = self._load_audio(instrumental_path, target_sr=44100)
        # demucs expects (batch=1, channels, samples)
        audio_tensor = torch.from_numpy(audio).unsqueeze(0).float().to(device)

        all_outputs = []
        for model in models:
            out = apply_model(model, audio_tensor, shifts=1, overlap=0.8)[0].cpu().numpy()
            all_outputs.append(out)

        # CDX23 output order: [0]=music, [1]=effect, [2]=dialog (dialog discarded)
        avg = np.mean(all_outputs, axis=0)
        music_audio = avg[0]    # (channels, samples)
        effects_audio = avg[1]  # (channels, samples)

        music_path = str(Path(self.output_dir) / f"{source_base}_Music.wav")
        effects_path = str(Path(self.output_dir) / f"{source_base}_Effects.wav")
        self._write_audio(music_path, music_audio, sr)
        self._write_audio(effects_path, effects_audio, sr)
        logger.info("Pass 2 complete: music=%s effects=%s", music_path, effects_path)
        return music_path, effects_path

    def run_surgical_pipeline(self, input_file, fast_mode=False):
        """
        Hybrid 3-stem cinematic pipeline.
        Returns: {DX, Music, Effects, DX_Residual (optional)}
        """
        source_base = Path(input_file).stem or "source"

        # Pass 1: MBR vocal split
        pass1_stems = self._pass1_mbr_vocal_split(input_file) or []
        cleanup_candidates = set(pass1_stems)

        vocals_stem = self._pick_stem(
            pass1_stems, required_tokens={"vocals"}
        )
        instrumental_stem = self._pick_stem(
            pass1_stems, required_tokens={"other"}
        ) or self._pick_stem(
            pass1_stems, forbidden_tokens={"vocals"}
        )

        if not vocals_stem:
            raise FileNotFoundError("Pass 1 did not produce a vocals stem.")
        if not instrumental_stem:
            raise FileNotFoundError("Pass 1 did not produce an instrumental stem.")

        # Pass 2: CDX23 on instrumental
        music_path, effects_path = self._pass2_cdx23_instrumental(
            instrumental_stem, source_base, fast_mode=fast_mode
        )
        cleanup_candidates.add(instrumental_stem)

        # Pass 2b: Optional DX refinement via BS-Roformer
        dx_residual = None
        if not fast_mode:
            logger.info("Pass 2b: BS-Roformer DX refinement...")
            self._load_model_with_fallback([
                "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
                "BS-Roformer-Viperx-1297.ckpt",
            ])
            pass2b_stems = self._separate(vocals_stem) or []
            cleanup_candidates.update(pass2b_stems)

            dx_candidate = (
                self._pick_stem(pass2b_stems, required_tokens={"vocals"}, forbidden_tokens={"reverb", "residual"})
                or self._pick_stem(pass2b_stems, required_tokens={"dx"})
            )
            dx_residual = (
                self._pick_stem(pass2b_stems, required_tokens={"instrumental"})
                or self._pick_stem(pass2b_stems, required_tokens={"residual"})
                or self._pick_stem(pass2b_stems, required_tokens={"reverb"})
            )
            vocals_stem = dx_candidate or vocals_stem
        else:
            logger.info("Fast mode: skipping Pass 2b DX refinement.")

        # Canonicalize
        dx_stem = self._canonicalize_stem_file(vocals_stem, source_base, "DX")
        music_stem = self._canonicalize_stem_file(music_path, source_base, "Music")
        effects_stem = self._canonicalize_stem_file(effects_path, source_base, "Effects")
        if dx_residual:
            dx_residual = self._canonicalize_stem_file(dx_residual, source_base, "DX_Residual")

        canonical_stems = {"DX": dx_stem, "Music": music_stem, "Effects": effects_stem}
        missing = [k for k, v in canonical_stems.items() if not v or not Path(v).exists()]
        if missing:
            raise FileNotFoundError(f"Missing canonical stem(s): {', '.join(missing)}")

        keep = list(canonical_stems.values())
        if dx_residual:
            keep.append(dx_residual)
        self._cleanup_intermediate_wavs(cleanup_candidates, keep)

        return {
            "DX": dx_stem,
            "Music": music_stem,
            "Effects": effects_stem,
            "DX_Residual": dx_residual,
        }


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <input_audio> [output_dir]", file=sys.stderr)
        sys.exit(1)

    _input_file = sys.argv[1]
    _output_dir = sys.argv[2] if len(sys.argv) > 2 else "./output"
    msep = MikupSeparator(output_dir=_output_dir)
    print(msep.run_surgical_pipeline(_input_file))
