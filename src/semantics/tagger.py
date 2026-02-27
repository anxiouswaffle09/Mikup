import torch
import librosa
import logging
from transformers import AutoProcessor, ClapModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class MikupSemanticTagger:
    """
    Stage 4: Semantic Audio Understanding.
    Uses CLAP to assign text tags to audio stems (Ambience, SFX, etc.).
    """

    def __init__(self, model_id="laion/clap-htsat-fused", device=None):
        if device is None:
            has_mps = hasattr(torch.backends, "mps") and torch.backends.mps.is_available()
            self.device = "cuda" if torch.cuda.is_available() else "mps" if has_mps else "cpu"
        else:
            self.device = device
        self.model_dtype = torch.float16 if self.device in {"cuda", "mps"} else torch.float32

        logger.info(f"Loading CLAP model {model_id} on {self.device}...")
        self.model = ClapModel.from_pretrained(
            model_id,
            torch_dtype=self.model_dtype,
        ).to(self.device)
        self.model.eval()
        self.processor = AutoProcessor.from_pretrained(model_id)
        
        # Default candidate labels for audio drama scenes
        self.default_labels = [
            "Rain and thunder",
            "Birds chirping in a forest",
            "Busy city traffic",
            "Crowded tavern or restaurant",
            "Wind howling",
            "Footsteps on gravel",
            "Electronic beeps and hums",
            "Silence or room tone",
            "Intense cinematic music",
            "Lo-fi background music",
            "Gunshots or explosions",
            "Ocean waves"
        ]

    def tag_audio(self, audio_path, candidate_labels=None):
        """
        Performs zero-shot classification on an audio file.
        Optimized to only load the required 5-second window into memory.
        """
        if candidate_labels is None:
            candidate_labels = self.default_labels

        logger.info(f"Tagging audio: {audio_path}")
        
        # Calculate duration first without loading the full audio
        full_duration = librosa.get_duration(path=audio_path)
        
        # Take the middle 5 seconds for a "vibe check"
        start_sec = max(0, (full_duration / 2) - 2.5) if full_duration > 7 else 0
        duration_to_load = min(5.0, full_duration)

        # Load and resample ONLY the 5-second window to 48kHz (CLAP standard)
        y, _ = librosa.load(audio_path, sr=48000, offset=start_sec, duration=duration_to_load)
        
        # Prepare inputs
        raw_inputs = self.processor(
            text=candidate_labels, 
            audios=y, 
            return_tensors="pt", 
            padding=True,
            sampling_rate=48000
        )
        inputs = {}
        for key, value in raw_inputs.items():
            if torch.is_tensor(value):
                if value.is_floating_point():
                    inputs[key] = value.to(device=self.device, dtype=self.model_dtype)
                else:
                    inputs[key] = value.to(device=self.device)
            else:
                inputs[key] = value

        with torch.no_grad():
            outputs = self.model(**inputs)
            
        # Get logits and compute probabilities
        logits_per_audio = outputs.logits_per_audio
        probs = logits_per_audio.softmax(dim=-1).cpu().numpy()[0]
        
        # Sort labels by probability
        results = sorted(
            [{"label": label, "score": float(prob)} for label, prob in zip(candidate_labels, probs)],
            key=lambda x: x["score"],
            reverse=True
        )
        
        return results[:3] # Return top 3 tags

if __name__ == "__main__":
    # Test with mock data
    tagger = MikupSemanticTagger()
    # Using a mock path from earlier
    mock_bg = "data/processed/test_Instrumental.wav"
    import os
    if os.path.exists(mock_bg):
        tags = tagger.tag_audio(mock_bg)
        print("Top Semantic Tags:")
        for tag in tags:
            print(f"- {tag['label']}: {tag['score']:.2%}")
