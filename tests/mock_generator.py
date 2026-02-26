import os
import json
import numpy as np
import soundfile as sf

def create_mock_data(input_file):
    processed_dir = "data/processed"
    os.makedirs(processed_dir, exist_ok=True)
    
    # Simulate filenames that the separator would produce
    base = os.path.basename(input_file).split('.')[0]
    
    stems = {
        "dialogue_raw": os.path.join(processed_dir, f"{base}_Vocals.wav"),
        "background_raw": os.path.join(processed_dir, f"{base}_Instrumental.wav"),
        "dialogue_dry": os.path.join(processed_dir, f"{base}_Dry_Vocals.wav"),
        "reverb_tail": os.path.join(processed_dir, f"{base}_Reverb.wav")
    }
    
    # Create valid silent WAV files (1 second at 44.1kHz)
    sample_rate = 44100
    duration = 10.0  # 10 seconds of mock audio
    t = np.linspace(0, duration, int(sample_rate * duration))
    # Add some very low level noise so the DSP doesn't divide by zero
    silence = np.random.uniform(-0.001, 0.001, len(t))
    
    for path in stems.values():
        sf.write(path, silence, sample_rate)
            
    # Create a mock transcription result for Stage 2
    mock_transcription = {
        "segments": [
            {"start": 1.0, "end": 3.5, "text": "I can't believe we're actually doing this.", "speaker": "SPEAKER_01"},
            {"start": 4.2, "end": 5.8, "text": "We don't have a choice, Arthur.", "speaker": "SPEAKER_02"},
            {"start": 7.5, "end": 9.2, "text": "The engine is failing, and we're losing oxygen.", "speaker": "SPEAKER_02"}
        ],
        "word_segments": [
            {"word": "I", "start": 1.0, "end": 1.2},
            {"word": "can't", "start": 1.2, "end": 1.5},
            {"word": "believe", "start": 1.5, "end": 1.8},
            {"word": "we're", "start": 1.8, "end": 2.0},
            {"word": "actually", "start": 2.0, "end": 2.5},
            {"word": "doing", "start": 2.5, "end": 3.0},
            {"word": "this", "start": 3.0, "end": 3.5}
        ]
    }
    
    trans_path = os.path.join(processed_dir, "mock_transcription.json")
    with open(trans_path, 'w') as f:
        json.dump(mock_transcription, f, indent=2)
        
    print(f"✅ Real-format Mock data generated in {processed_dir}")
    return stems, trans_path

if __name__ == "__main__":
    create_mock_data("test.wav")

if __name__ == "__main__":
    create_mock_data("test.wav")
