#!/usr/bin/env python3
"""
Hybrid separation test: Mel-Band Roformer (vocals) → CDX23 (music/effects)

Step 1: Extract dialog (vocals) from original mix using vocals_mel_band_roformer.ckpt
Step 2: Run CDX23 on the instrumental residual to get music vs effects

Final outputs in data/test_hybrid/:
  dialog.wav   - clean dialogue (from MBR vocal separator)
  music.wav    - music score (from CDX23 on instrumental)
  effects.wav  - hard FX (from CDX23 on instrumental)
"""

import gc
import os
import shutil
import sys

import torch

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INPUT_FILE = os.path.join(REPO_ROOT, 'cts1_ep01_master.wav')
OUTPUT_DIR = os.path.join(REPO_ROOT, 'data', 'test_hybrid')
CDX23_DIR = '/tmp/cdx23'

os.makedirs(OUTPUT_DIR, exist_ok=True)

# ── Step 1: Mel-Band Roformer vocal separation ─────────────────────────────────
print('=== Step 1: Mel-Band Roformer (vocals/other) ===')
print(f'Input: {INPUT_FILE}')

from audio_separator.separator import Separator

sep = Separator(output_dir=OUTPUT_DIR, output_format='WAV')
sep.load_model('vocals_mel_band_roformer.ckpt')
step1_files = sep.separate(INPUT_FILE)
print(f'Step 1 outputs: {step1_files}')

# audio-separator returns bare filenames relative to output_dir — make them absolute
step1_files = [
    f if os.path.isabs(f) else os.path.join(OUTPUT_DIR, f)
    for f in step1_files
]

# Identify vocals vs instrumental by filename (audio-separator uses lowercase stem names in parens)
vocals_src = next(
    (f for f in step1_files if '(vocals)' in os.path.basename(f).lower()),
    None
)
if vocals_src is None:
    raise RuntimeError(f'Could not identify vocals stem in: {step1_files}')
other_src = next(f for f in step1_files if f != vocals_src)

dialog_path = os.path.join(OUTPUT_DIR, 'dialog.wav')
instrumental_path = os.path.join(OUTPUT_DIR, 'instrumental.wav')

os.rename(vocals_src, dialog_path)
os.rename(other_src, instrumental_path)
print(f'dialog.wav      ← {os.path.basename(vocals_src)}')
print(f'instrumental.wav ← {os.path.basename(other_src)}')

# Free VRAM before loading CDX23
del sep
gc.collect()
torch.cuda.empty_cache()

# ── Step 2: CDX23 on instrumental ─────────────────────────────────────────────
print('\n=== Step 2: CDX23 (music/effects) on instrumental.wav ===')

sys.path.insert(0, CDX23_DIR)
from inference import predict_with_model

predict_with_model({
    'input_audio': [instrumental_path],
    'output_folder': OUTPUT_DIR,
    'high_quality': True,
    'cpu': False,
})

# CDX23 names outputs after the input stem: instrumental_{music,effect,...}.wav
inst_base = 'instrumental'
music_src = os.path.join(OUTPUT_DIR, f'{inst_base}_music.wav')
effect_src = os.path.join(OUTPUT_DIR, f'{inst_base}_effect.wav')

music_path = os.path.join(OUTPUT_DIR, 'music.wav')
effects_path = os.path.join(OUTPUT_DIR, 'effects.wav')

os.rename(music_src, music_path)
os.rename(effect_src, effects_path)
print(f'music.wav   ← {inst_base}_music.wav')
print(f'effects.wav ← {inst_base}_effect.wav')

# Discard intermediate and CDX23 artifacts we don't need
os.remove(instrumental_path)
for artifact_name in [f'{inst_base}_dialog.wav', f'{inst_base}_instrum.wav', f'{inst_base}_instrum2.wav']:
    artifact = os.path.join(OUTPUT_DIR, artifact_name)
    if os.path.exists(artifact):
        os.remove(artifact)

print('\n=== Done ===')
for name in ('dialog.wav', 'music.wav', 'effects.wav'):
    path = os.path.join(OUTPUT_DIR, name)
    size_mb = os.path.getsize(path) / (1024 * 1024) if os.path.exists(path) else 0
    print(f'  {name}: {size_mb:.1f} MB')
