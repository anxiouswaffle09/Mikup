import librosa
import numpy as np
import logging
import json
import os
import sys

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class MikupDSPProcessor:
    """
    Stage 3: Feature Extraction (The 'Physics' Engine).
    Analyzes separated stems and transcription data to calculate objective metrics.
    """

    def __init__(self, sample_rate=22050, analysis_window_seconds=90.0):
        self.sr = sample_rate
        self.analysis_window_seconds = analysis_window_seconds

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

    def calculate_loudness_curve(self, y, frame_length=2048, hop_length=512):
        """Calculates the RMS energy curve (proxy for perceived loudness)."""
        rms = librosa.feature.rms(y=y, frame_length=frame_length, hop_length=hop_length)[0]
        # Avoid -inf for absolute silence
        if np.max(rms) == 0:
            return np.zeros_like(rms)
        rms_db = librosa.amplitude_to_db(rms, ref=np.max)
        return rms_db

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
        if np.var(left) == 0 or np.var(right) == 0:
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

    def analyze_ducking(self, dialogue_y, music_y, hop_length=512):
        """
        Identifies 'Impact Mikups' where music ducks specifically for dialogue.
        Uses a dynamic calculation comparing RMS peaks.
        """
        # Load as mono for RMS calculation if needed, but the original loading is stereo
        diag_mono = librosa.to_mono(dialogue_y) if dialogue_y.ndim > 1 else dialogue_y
        music_mono = librosa.to_mono(music_y) if music_y.ndim > 1 else music_y

        diag_rms = librosa.feature.rms(y=diag_mono, hop_length=hop_length)[0]
        music_rms = librosa.feature.rms(y=music_mono, hop_length=hop_length)[0]
        
        # Ducking index: measure correlation or inverse relationship
        # Add 1e-6 to avoid divide by zero
        mean_dialogue = self.safe_float(np.mean(diag_rms))
        mean_music = self.safe_float(np.mean(music_rms))
        if mean_dialogue is None or mean_music is None:
            return None

        ducking_index = mean_dialogue / (mean_music + 1e-6)
        
        # Clamp to realistic bounds
        return self.safe_float(min(ducking_index, 100.0))

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
            "impact_metrics": {}
        }

        # Analyze dialogue/reverb using bounded windows to avoid OOM on long inputs.
        if self._is_existing_file(stems.get("dialogue_dry")):
            try:
                y, _ = self._load_analysis_window(stems["dialogue_dry"], mono=False)
                vocal_clarity = self.safe_float(
                    np.mean(librosa.feature.spectral_centroid(y=librosa.to_mono(y), sr=self.sr))
                )
                if vocal_clarity is not None:
                    results["spatial_metrics"]["vocal_clarity"] = vocal_clarity
                results["spatial_metrics"]["vocal_width"] = self.calculate_stereo_width(y)
            except (OSError, ValueError, RuntimeError) as exc:
                logger.error("Error processing dialogue_dry: %s", exc)

        # Analyze Reverb Tail
        if self._is_existing_file(stems.get("reverb_tail")):
            try:
                y_rev, _ = self._load_analysis_window(stems["reverb_tail"], mono=False)
                reverb_density = self.safe_float(np.mean(librosa.feature.rms(y=librosa.to_mono(y_rev))))
                if reverb_density is not None:
                    results["spatial_metrics"]["reverb_density"] = reverb_density
                results["spatial_metrics"]["reverb_width"] = self.calculate_stereo_width(y_rev)
            except (OSError, ValueError, RuntimeError) as exc:
                logger.error("Error processing reverb_tail: %s", exc)

        # Analyze Music/Background for Ducking
        if self._is_existing_file(stems.get("dialogue_raw")) and self._is_existing_file(stems.get("background_raw")):
            try:
                y_diag, y_bg = self._load_aligned_windows(
                    stems["dialogue_raw"],
                    stems["background_raw"],
                    mono=False,
                )
                ducking_intensity = self.analyze_ducking(y_diag, y_bg)
                if ducking_intensity is not None:
                    results["impact_metrics"]["ducking_intensity"] = ducking_intensity
            except (OSError, ValueError, RuntimeError) as exc:
                logger.error("Error processing ducking metrics: %s", exc)

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
