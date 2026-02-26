import os
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
        primary_stems = self.separate_dialogue(input_file)
        
        # Identify dialogue stem (usually contains 'Vocals' in the filename)
        dialogue_stem = next((f for f in primary_stems if "Vocals" in f), None)
        bg_stem = next((f for f in primary_stems if "Instrumental" in f), None)
        
        results = {
            "dialogue_raw": dialogue_stem,
            "background_raw": bg_stem,
        }
        
        if dialogue_stem:
            # 2. De-reverb the dialogue for spatial metrics
            reverb_stems = self.dereverb_dialogue(dialogue_stem)
            results["dialogue_dry"] = next((f for f in reverb_stems if "No_Reverb" in f or "Vocals" in f), None)
            results["reverb_tail"] = next((f for f in reverb_stems if "Reverb" in f), None)
            
        return results

if __name__ == "__main__":
    # Example usage (standalone)
    import sys
    if len(sys.argv) > 1:
        msep = MikupSeparator()
        msep.run_surgical_pipeline(sys.argv[1])
