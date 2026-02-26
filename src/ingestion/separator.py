import os
import re
import logging
from audio_separator.separator import Separator

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class MikupSeparator:
    """
    Surgical Audio Separation for Project Mikup.
    Handles multi-pass separation to extract clean dialogue, SFX, and reverb tails.
    """
    
    def __init__(self, output_dir="data/processed"):
        self.output_dir = output_dir
        os.makedirs(self.output_dir, exist_ok=True)
        self.separator = Separator() # Single instance to be reused

    @staticmethod
    def _tokens_from_path(file_path):
        """Extract normalized stem tokens from a path for structured matching."""
        if not isinstance(file_path, str):
            return set()
        stem_name = os.path.splitext(os.path.basename(file_path))[0].lower()
        tokens = {token for token in re.split(r"[^a-z0-9]+", stem_name) if token}
        # Normalize compact form used by some models.
        if "noreverb" in tokens:
            tokens.update({"no", "reverb"})
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
        
    def separate_dialogue(self, input_file, model_name="BS-Roformer-Viperx-v2.ckpt"):
        """
        Pass 1: Isolate Dialogue from everything else using SOTA Roformer.
        """
        logger.info(f"Starting Pass 1: Dialogue Isolation using {model_name}...")
        
        self.separator.load_model(model_name)
        
        # output_names will contain the paths to the separated files
        output_files = self.separator.separate(input_file)
        
        # Usually Roformer returns [Vocals, Instrumental]
        # In our context: Vocals = Dialogue, Instrumental = Music + SFX
        logger.info(f"Pass 1 complete. Stems generated: {output_files}")
        return output_files

    def dereverb_dialogue(self, dialogue_file, model_name="UVR-DeEcho-DeReverb.nmf"):
        """
        Pass 2: Split isolated dialogue into Dry Voice and Reverb Tail.
        Essential for 'Spatial Mikup' metrics.
        """
        logger.info(f"Starting Pass 2: De-Reverb using {model_name}...")
        
        self.separator.load_model(model_name)
        
        output_files = self.separator.separate(dialogue_file)
        
        logger.info(f"Pass 2 complete. Stems generated: {output_files}")
        return output_files

    def run_surgical_pipeline(self, input_file):
        """
        Runs the full Mikup Stage 1 pipeline.
        """
        # 1. Separate Dialogue from Music/SFX
        primary_stems = self.separate_dialogue(input_file) or []
        
        # Identify dialogue and background stems using structured token matching.
        dialogue_stem = self._pick_stem(primary_stems, required_tokens={"vocals"})
        bg_stem = self._pick_stem(primary_stems, required_tokens={"instrumental"})
        
        results = {
            "dialogue_raw": dialogue_stem,
            "background_raw": bg_stem,
        }
        
        if dialogue_stem:
            # 2. De-reverb the dialogue for spatial metrics
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
            
        return results

if __name__ == "__main__":
    # Example usage (standalone)
    import sys
    if len(sys.argv) > 1:
        msep = MikupSeparator()
        msep.run_surgical_pipeline(sys.argv[1])
