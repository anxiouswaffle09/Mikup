import librosa
import numpy as np
import logging
import json
import os
import sys
import pyloudnorm as pyln
from scipy.signal import oaconvolve

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class MikupDSPProcessor:
    """
    Stage 3: Feature Extraction (The 'Physics' Engine).
    Analyzes separated stems and transcription data to calculate objective metrics.
    Updated for Sprint 02: EBU R128 LUFS, SNR, and Stereo Balance.
    """

    def __init__(self, sample_rate=22050, analysis_window_seconds=None):
        self.sr = sample_rate
        self.analysis_window_seconds = analysis_window_seconds
        # EBU R128 Meter
        self.meter = pyln.Meter(self.sr)

    @staticmethod
    def _is_existing_file(path):
        return isinstance(path, str) and bool(path.strip()) and os.path.exists(path)

    def safe_float(self, val):
        """Convert to finite float. Returns None for malformed or non-finite values."""
        try:
            if val is None:
                return None
            if isinstance(val, str):
                val = val.strip()
                if not val:
                    return None
            num = float(val)
        except (TypeError, ValueError):
            return None

        if not np.isfinite(num):
            return None
        return num

    def _load_analysis_window(self, audio_path, mono=False, max_duration=None):
        """
        Load full-file audio by default. Optional max_duration can bound loading when needed.
        """
        full_duration = librosa.get_duration(path=audio_path)
        duration_limit = max_duration if max_duration is not None else self.analysis_window_seconds
        if full_duration <= 0:
            raise ValueError(f"Audio has non-positive duration: {audio_path}")

        if duration_limit is None:
            return librosa.load(audio_path, sr=self.sr, mono=mono)

        duration = min(full_duration, duration_limit)
        offset = max(0.0, (full_duration - duration) / 2.0)
        return librosa.load(audio_path, sr=self.sr, mono=mono, offset=offset, duration=duration)

    def _load_aligned_windows(self, audio_path_a, audio_path_b, mono=False, max_duration=None):
        duration_a = librosa.get_duration(path=audio_path_a)
        duration_b = librosa.get_duration(path=audio_path_b)
        duration_limit = max_duration if max_duration is not None else self.analysis_window_seconds
        shared_duration = min(duration_a, duration_b)
        if duration_limit is not None:
            shared_duration = min(shared_duration, duration_limit)
        if shared_duration <= 0:
            raise ValueError("Aligned audio window duration must be positive.")

        min_duration = min(duration_a, duration_b)
        offset = max(0.0, (min_duration - shared_duration) / 2.0)
        y_a, _ = librosa.load(
            audio_path_a, sr=self.sr, mono=mono, offset=offset, duration=shared_duration
        )
        y_b, _ = librosa.load(
            audio_path_b, sr=self.sr, mono=mono, offset=offset, duration=shared_duration
        )
        return y_a, y_b

    @staticmethod
    def _moving_mean(signal, window_size):
        """Vectorized centered moving mean with edge normalization."""
        if signal.size == 0:
            return np.array([], dtype=np.float32)
        if window_size <= 1:
            return signal.astype(np.float32, copy=True)

        window = np.ones(window_size, dtype=np.float32)
        summed = oaconvolve(signal, window, mode="same")
        counts = oaconvolve(np.ones(signal.shape[0], dtype=np.float32), window, mode="same")
        return (summed / np.maximum(counts, 1.0)).astype(np.float32, copy=False)

    def _moving_mean_chunked(self, signal, window_size, chunk_samples):
        """
        Chunk-safe centered moving mean for long audio.
        Uses overlap to preserve identical values at chunk boundaries.
        """
        n_samples = signal.shape[0]
        if n_samples <= chunk_samples:
            return self._moving_mean(signal, window_size)

        output = np.empty(n_samples, dtype=np.float32)
        half_window = window_size // 2
        for chunk_start in range(0, n_samples, chunk_samples):
            chunk_end = min(n_samples, chunk_start + chunk_samples)
            ext_start = max(0, chunk_start - half_window)
            ext_end = min(n_samples, chunk_end + half_window)

            local = signal[ext_start:ext_end]
            local_mean = self._moving_mean(local, window_size)

            core_start = chunk_start - ext_start
            core_end = core_start + (chunk_end - chunk_start)
            output[chunk_start:chunk_end] = local_mean[core_start:core_end]

        return output

    def calculate_lufs_series(self, y, hop_length=11025):
        """
        Calculates LUFS time-series using K-weighting.
        Returns Integrated, Short-term (3s), and Momentary (400ms) curves.
        Default hop_length of 11025 at 22050Hz = 2 data points per second.
        """
        if hop_length <= 0:
            hop_length = 1

        # Ensure correct shape for pyloudnorm (samples, channels)
        if y.ndim == 1:
            y_pyln = y[:, np.newaxis]
        else:
            y_pyln = y.T

        if y_pyln.shape[0] == 0:
            return {"integrated": -70.0, "momentary": [], "short_term": []}
            
        # 1. Integrated LUFS
        try:
            integrated = self.meter.integrated_loudness(y_pyln)
        except (ValueError, RuntimeError) as e:
            logger.warning("LUFS calc failed: %s", e)
            integrated = -70.0

        # 2. K-weighted signal for ST/M calculation
        # In pyloudnorm 0.2.0, we iterate through internal filters
        y_weighted = y_pyln.copy()
        try:
            for f in self.meter._filters.values():
                y_weighted = f.apply_filter(y_weighted)
        except Exception as e:
            logger.warning(f"Manual K-weighting failed: {e}. Falling back to unweighted.")
            y_weighted = y_pyln
        
        # Momentary: 400ms window
        m_win = int(0.4 * self.sr)
        # Short-term: 3s window
        st_win = int(3.0 * self.sr)

        # Collapse channels to a single per-sample mean-square signal.
        squared = np.square(y_weighted.astype(np.float32, copy=False))
        mean_square = np.mean(squared, axis=1, dtype=np.float32)

        # Memory safety: process long signals in 15-minute chunks.
        chunk_samples = int(15 * 60 * self.sr)
        momentary_ms = self._moving_mean_chunked(mean_square, m_win, chunk_samples)
        short_term_ms = self._moving_mean_chunked(mean_square, st_win, chunk_samples)

        # Vectorized LUFS transform.
        # Calibrate the series so its global average aligns to the file-wide integrated LUFS.
        series_integrated = 10.0 * np.log10(np.maximum(np.mean(mean_square), 1e-12)) - 0.691
        calibration_offset = float(integrated) - float(series_integrated)
        momentary_lufs = 10.0 * np.log10(np.maximum(momentary_ms, 1e-12)) - 0.691
        short_term_lufs = 10.0 * np.log10(np.maximum(short_term_ms, 1e-12)) - 0.691
        momentary_lufs += calibration_offset
        short_term_lufs += calibration_offset

        # Downsample for compact payloads.
        sample_idx = np.arange(0, mean_square.shape[0], hop_length, dtype=np.int64)
        m_lufs = np.clip(momentary_lufs[sample_idx], -70.0, 0.0).astype(np.float32)
        st_lufs = np.clip(short_term_lufs[sample_idx], -70.0, 0.0).astype(np.float32)

        return {
            "integrated": float(integrated),
            "momentary": m_lufs.tolist(),
            "short_term": st_lufs.tolist()
        }

    def calculate_stereo_balance(self, y_stereo):
        """
        Calculates L/R energy distribution.
        -1 = Pure Left, 0 = Balanced, +1 = Pure Right.
        """
        if y_stereo.ndim < 2 or y_stereo.shape[0] < 2:
            return 0.0
            
        l_rms = np.sqrt(np.mean(y_stereo[0]**2) + 1e-12)
        r_rms = np.sqrt(np.mean(y_stereo[1]**2) + 1e-12)
        
        balance = (r_rms - l_rms) / (l_rms + r_rms + 1e-12)
        return float(np.clip(balance, -1.0, 1.0))

    def calculate_snr(self, dialogue_y, background_y):
        """
        Calculates Speech-to-Noise Ratio (SNR) for Intelligibility.
        """
        diag_mono = librosa.to_mono(dialogue_y) if dialogue_y.ndim > 1 else dialogue_y
        bg_mono = librosa.to_mono(background_y) if background_y.ndim > 1 else background_y
        
        diag_pow = np.mean(diag_mono**2) + 1e-12
        bg_pow = np.mean(bg_mono**2) + 1e-12
        
        snr = 10 * np.log10(diag_pow / bg_pow)
        return float(np.clip(snr, -20, 60))

    def calculate_stereo_width(self, y_stereo):
        """
        Calculates the phase correlation between L and R channels.
        +1 = Mono, 0 = Wide Stereo, -1 = Out of Phase.
        """
        if y_stereo.ndim < 2 or y_stereo.shape[0] < 2:
            return 1.0 # Mono if single channel
        
        left = y_stereo[0]
        right = y_stereo[1]
        
        # Guard against zero-variance signals (pure silence)
        if np.var(left) < 1e-10 or np.var(right) < 1e-10:
            return 1.0
            
        correlation = np.corrcoef(left, right)[0, 1]
        safe_correlation = self.safe_float(correlation)
        return safe_correlation if safe_correlation is not None else 1.0

    def analyze_pacing(self, transcription_data):
        """
        Calculates pacing events (silence gaps between adjacent speaker segments).
        """
        segments = transcription_data.get("segments", [])
        if not isinstance(segments, list):
            return []
        gaps = []
        
        for i in range(len(segments) - 1):
            end_prev = self.safe_float(segments[i].get("end"))
            start_next = self.safe_float(segments[i+1].get("start"))
            if end_prev is None or start_next is None:
                continue
            gap_duration = start_next - end_prev
            
            if gap_duration > 0:
                gaps.append({
                    "timestamp": end_prev,
                    "duration_ms": int(gap_duration * 1000),
                    "context": f"Between {segments[i].get('speaker', 'Unknown')} and {segments[i+1].get('speaker', 'Unknown')}"
                })
        
        return gaps

    def process_stems(self, stems, transcription_path):
        """
        Full processing pass for a set of stems.
        """
        logger.info("Starting DSP Feature Extraction...")
        if not isinstance(stems, dict):
            raise ValueError("stems must be a dictionary of stem paths")
        
        # Load Transcription
        if not self._is_existing_file(transcription_path):
            trans_data = {"segments": []}
        else:
            try:
                with open(transcription_path, "r", encoding="utf-8") as f:
                    trans_data = json.load(f)
            except (OSError, json.JSONDecodeError) as exc:
                logger.warning("Failed to read transcription data from %s: %s", transcription_path, exc)
                trans_data = {"segments": []}
            
        # Get total duration from one of the stems
        sample_stem = next(
            (
                path for path in (
                    stems.get("dialogue_raw"),
                    stems.get("background_raw"),
                )
                if self._is_existing_file(path)
            ),
            None
        )
        if sample_stem is None:
            raise FileNotFoundError("No usable dialogue/background stem found for DSP analysis.")
        total_duration = self.safe_float(librosa.get_duration(path=sample_stem))

        results = {
            "pacing_mikups": self.analyze_pacing(trans_data),
            "spatial_metrics": {
                "total_duration": total_duration if total_duration is not None else 0.0
            },
            "impact_metrics": {},
            "lufs_graph": {}
        }

        # LUFS Analysis for all stems
        for stem_key in ["dialogue_raw", "background_raw"]:
            if self._is_existing_file(stems.get(stem_key)):
                try:
                    y, _ = self._load_analysis_window(stems[stem_key], mono=False)
                    results["lufs_graph"][stem_key] = self.calculate_lufs_series(y)
                except Exception as exc:
                    logger.error("Error calculating LUFS for %s: %s", stem_key, exc)

        # Diagnostic Meter Metrics
        if self._is_existing_file(stems.get("dialogue_raw")) and self._is_existing_file(stems.get("background_raw")):
            try:
                y_diag, y_bg = self._load_aligned_windows(
                    stems["dialogue_raw"],
                    stems["background_raw"],
                    mono=False,
                )
                results["diagnostic_meters"] = {
                    "intelligibility_snr": self.calculate_snr(y_diag, y_bg),
                    "stereo_correlation": self.calculate_stereo_width(y_diag), # Use dialogue width as proxy for now
                    "stereo_balance": self.calculate_stereo_balance(y_diag)
                }
            except (OSError, ValueError, RuntimeError) as exc:
                logger.error("Error processing diagnostic metrics: %s", exc)

        logger.info("DSP Processing Complete.")
        return results

if __name__ == "__main__":
    # Example usage
    processor = MikupDSPProcessor()
    # Mock paths
    mock_stems = {
        "dialogue_dry": "data/processed/test_Dry_Vocals.wav",
        "reverb_tail": "data/processed/test_Reverb.wav",
        "dialogue_raw": "data/processed/test_Vocals.wav",
        "background_raw": "data/processed/test_Instrumental.wav"
    }
    mock_trans = "data/processed/mock_transcription.json"

    if os.path.exists(mock_trans):
        try:
            report = processor.process_stems(mock_stems, mock_trans)
            print(json.dumps(report, indent=2))
        except (FileNotFoundError, OSError, ValueError, RuntimeError) as exc:
            logger.error("DSP processing failed: %s", exc)
            sys.exit(1)
