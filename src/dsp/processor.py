import librosa
import numpy as np
import logging
import json
import os

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class MikupDSPProcessor:
    """
    Stage 3: Feature Extraction (The 'Physics' Engine).
    Analyzes separated stems and transcription data to calculate objective metrics.
    """

    def __init__(self, sample_rate=22050):
        self.sr = sample_rate

    def calculate_loudness_curve(self, y, frame_length=2048, hop_length=512):
        """Calculates the RMS energy curve (proxy for perceived loudness)."""
        rms = librosa.feature.rms(y=y, frame_length=frame_length, hop_length=hop_length)[0]
        # Convert to dB
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
        
        correlation = np.corrcoef(left, right)[0, 1]
        return float(correlation)

    def analyze_pacing(self, transcription_data):
        """
        Calculates 'Pacing Mikups' - silence gaps between speaker segments.
        """
        segments = transcription_data.get("segments", [])
        gaps = []
        
        for i in range(len(segments) - 1):
            end_prev = segments[i]["end"]
            start_next = segments[i+1]["start"]
            gap_duration = start_next - end_prev
            
            if gap_duration > 0:
                gaps.append({
                    "timestamp": end_prev,
                    "duration_ms": int(gap_duration * 1000),
                    "context": f"Between {segments[i].get('speaker')} and {segments[i+1].get('speaker')}"
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
        # Placeholder for real-time dynamic range analysis
        ducking_index = np.mean(diag_rms) / (np.mean(music_rms) + 1e-6)
        return float(ducking_index)

    def process_stems(self, stems, transcription_path):
        """
        Full processing pass for a set of stems.
        """
        logger.info("Starting DSP Feature Extraction...")
        
        # Load Transcription
        with open(transcription_path, 'r') as f:
            trans_data = json.load(f)
            
        # Get total duration from one of the stems
        sample_stem = stems.get("dialogue_raw") or stems.get("background_raw")
        total_duration = librosa.get_duration(path=sample_stem) if sample_stem else 0

        results = {
            "pacing_mikups": self.analyze_pacing(trans_data),
            "spatial_metrics": {
                "total_duration": total_duration
            },
            "impact_metrics": {}
        }

        # Analyze Dialogue (Dry) - Load as STEREO (mono=False)
        if stems.get("dialogue_dry"):
            y, _ = librosa.load(stems["dialogue_dry"], sr=self.sr, mono=False)
            results["spatial_metrics"]["vocal_clarity"] = float(np.mean(librosa.feature.spectral_centroid(y=librosa.to_mono(y), sr=self.sr)))
            results["spatial_metrics"]["vocal_width"] = self.calculate_stereo_width(y)

        # Analyze Reverb Tail
        if stems.get("reverb_tail"):
            y_rev, _ = librosa.load(stems["reverb_tail"], sr=self.sr, mono=False)
            results["spatial_metrics"]["reverb_density"] = float(np.mean(librosa.feature.rms(y=librosa.to_mono(y_rev))))
            results["spatial_metrics"]["reverb_width"] = self.calculate_stereo_width(y_rev)

        # Analyze Music/Background for Ducking
        if stems.get("dialogue_raw") and stems.get("background_raw"):
            y_diag, _ = librosa.load(stems["dialogue_raw"], sr=self.sr, mono=False)
            y_bg, _ = librosa.load(stems["background_raw"], sr=self.sr, mono=False)
            results["impact_metrics"]["ducking_intensity"] = self.analyze_ducking(y_diag, y_bg)

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
        report = processor.process_stems(mock_stems, mock_trans)
        print(json.dumps(report, indent=2))
