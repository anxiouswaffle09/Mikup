import librosa
import numpy as np
import logging
import json
import os
import sys
import pyloudnorm as pyln

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class MikupDSPProcessor:
    """
    Stage 3: Feature Extraction (The 'Physics' Engine).
    Analyzes separated stems and transcription data to calculate objective metrics.
    Updated for Sprint 02: EBU R128 LUFS, SNR, and Stereo Balance.
    """

    def __init__(self, sample_rate=22050, analysis_window_seconds=90.0):
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
        Load a centered window instead of full-file audio to limit peak memory usage.
        """
        full_duration = librosa.get_duration(path=audio_path)
        duration = min(
            full_duration,
            max_duration if max_duration is not None else self.analysis_window_seconds
        )
        if duration <= 0:
            raise ValueError(f"Audio has non-positive duration: {audio_path}")

        offset = max(0.0, (full_duration - duration) / 2.0)
        return librosa.load(audio_path, sr=self.sr, mono=mono, offset=offset, duration=duration)

    def _load_aligned_windows(self, audio_path_a, audio_path_b, mono=False, max_duration=None):
        duration_a = librosa.get_duration(path=audio_path_a)
        duration_b = librosa.get_duration(path=audio_path_b)
        shared_duration = min(
            duration_a,
            duration_b,
            max_duration if max_duration is not None else self.analysis_window_seconds
        )
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

    def calculate_lufs_series(self, y, hop_length=11025):
        """
        Calculates LUFS time-series using K-weighting.
        Returns Integrated, Short-term (3s), and Momentary (400ms) curves.
        Default hop_length of 11025 at 22050Hz = 2 data points per second.
        """
        # Ensure correct shape for pyloudnorm (samples, channels)
        if y.ndim == 1:
            y_pyln = y[:, np.newaxis]
        else:
            y_pyln = y.T
            
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
        
        m_lufs = []
        st_lufs = []
        
        # Calculate in windows
        for i in range(0, len(y_weighted), hop_length):
            # Momentary
            m_start = max(0, i - m_win // 2)
            m_end = min(len(y_weighted), i + m_win // 2)
            m_segment = y_weighted[m_start:m_end]
            if len(m_segment) > 0:
                m_val = 10 * np.log10(np.mean(m_segment**2) + 1e-12) - 0.691
                m_lufs.append(float(np.clip(m_val, -70, 0)))
            else:
                m_lufs.append(-70.0)
                
            # Short-term
            st_start = max(0, i - st_win // 2)
            st_end = min(len(y_weighted), i + st_win // 2)
            st_segment = y_weighted[st_start:st_end]
            if len(st_segment) > 0:
                st_val = 10 * np.log10(np.mean(st_segment**2) + 1e-12) - 0.691
                st_lufs.append(float(np.clip(st_val, -70, 0)))
            else:
                st_lufs.append(-70.0)
                
        return {
            "integrated": float(integrated),
            "momentary": m_lufs,
            "short_term": st_lufs
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
        Calculates 'Pacing Mikups' - silence gaps between speaker segments.
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
