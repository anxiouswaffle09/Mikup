# Hybrid Separation Pipeline (3-Stem) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the 5-stem MDX-NET Cinematic Trinity pipeline with a 3-stem hybrid (MBR vocals → CDX23 instrumental split), removing all Foley/SFX/Ambience references across Python, Rust, TypeScript, and docs.

**Architecture:** MBR `vocals_mel_band_roformer.ckpt` extracts clean DX in Pass 1; CDX23 (via demucs API, already a transitive dep) splits the instrumental residual into Music + Effects in Pass 2; optional BS-Roformer Pass 2b for DX_Residual (toggled by `fast_mode`). Canonical stems collapse from 5 → 3: DX, Music, Effects.

**Tech Stack:** Python/audio-separator/demucs, Rust/Tauri, React/TypeScript, librosa, soundfile.

---

### Task 1: Rewrite `separator.py` — new 3-pass pipeline

**Files:**
- Modify: `src/ingestion/separator.py`

**Step 1: Delete removed methods**

Remove these methods entirely (they will be replaced):
- `separate_cinematic_trinity` (lines ~402–416)
- `refine_dialogue` (lines ~418–431)
- `_split_other_stem` (lines ~341–400)
- `_classify_percussive_stem` (lines ~312–339)
- `_semantic_scores` (lines ~293–310)
- `_get_semantic_tagger` (lines ~280–291)

**Step 2: Update `CANONICAL_STEMS` and class docstring**

```python
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
```

**Step 3: Add CDX23 models dir helper (new private method)**

```python
def _cdx23_models_dir(self):
    base = os.environ.get("MIKUP_CDX23_MODELS_DIR") or os.path.expanduser(
        "~/.cache/mikup/cdx23"
    )
    os.makedirs(base, exist_ok=True)
    return base
```

**Step 4: Add `_pass1_mbr_vocal_split` method**

```python
def _pass1_mbr_vocal_split(self, input_file):
    """Pass 1: Extract vocals (DX) and instrumental via MBR."""
    logger.info("Pass 1: MBR vocal split (vocals_mel_band_roformer.ckpt)...")
    self._load_model_with_fallback(["vocals_mel_band_roformer.ckpt"])
    output_files = self._separate(input_file)
    logger.info("Pass 1 complete. Stems: %s", output_files)
    return output_files
```

**Step 5: Add `_pass2_cdx23_instrumental` method**

```python
def _pass2_cdx23_instrumental(self, instrumental_path, source_base, fast_mode=False):
    """Pass 2: CDX23 (Demucs4/DnR) splits instrumental → music + effects."""
    import numpy as np
    import torch
    from demucs.apply import apply_model
    from demucs.states import load_model

    logger.info("Pass 2: CDX23 instrumental split...")
    models_dir = self._cdx23_models_dir()
    model_ids = self.CDX23_MODEL_IDS_FAST if fast_mode else self.CDX23_MODEL_IDS_HQ
    device = self.device if self.device != "mps" else "cpu"

    models = []
    for model_id in model_ids:
        model_path = os.path.join(models_dir, model_id)
        if not os.path.isfile(model_path):
            logger.info("Downloading CDX23 model: %s", model_id)
            torch.hub.download_url_to_file(
                self.CDX23_DOWNLOAD_BASE + model_id, model_path
            )
        model = load_model(model_path)
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

    music_path = os.path.join(self.output_dir, f"{source_base}_Music.wav")
    effects_path = os.path.join(self.output_dir, f"{source_base}_Effects.wav")
    self._write_audio(music_path, music_audio, sr)
    self._write_audio(effects_path, effects_audio, sr)
    logger.info("Pass 2 complete: music=%s effects=%s", music_path, effects_path)
    return music_path, effects_path
```

**Step 6: Rewrite `run_surgical_pipeline`**

```python
def run_surgical_pipeline(self, input_file, fast_mode=False):
    """
    Hybrid 3-stem cinematic pipeline.
    Returns: {DX, Music, Effects, DX_Residual (optional)}
    """
    source_base = os.path.splitext(os.path.basename(input_file))[0] or "source"

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
    missing = [k for k, v in canonical_stems.items() if not v or not os.path.exists(v)]
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
```

**Step 7: Verify no remaining references to old stems in separator.py**

```bash
grep -n "Foley\|SFX\|Ambience\|foley\|sfx\|ambience\|cinematic_trinity\|refine_dialogue\|split_other" src/ingestion/separator.py
```
Expected: no output.

**Step 8: Commit**

```bash
git add src/ingestion/separator.py
git commit -m "feat(sep): hybrid MBR→CDX23 pipeline, 3-stem output (DX/Music/Effects)"
```

---

### Task 2: Update `main.py` — 3-stem constants and helpers

**Files:**
- Modify: `src/main.py`

**Step 1: Update constants**

```python
CANONICAL_STEM_KEYS = ("DX", "Music", "Effects")
OPTIONAL_STEM_KEYS = ("DX_Residual",)
```

**Step 2: Update `_extract_canonical_stems` key_aliases**

Replace the existing `key_aliases` dict:

```python
key_aliases = {
    "DX": ("DX", "dialogue_dry", "dialogue_raw"),
    "Music": ("Music", "music"),
    "Effects": ("Effects", "effects", "background_raw"),
    "DX_Residual": ("DX_Residual", "reverb_tail"),
}
```

**Step 3: Update `_mock_stems`**

```python
def _mock_stems(output_dir, source_hint="mock"):
    base_name = os.path.splitext(os.path.basename(source_hint))[0] or "mock"
    stems = {
        "DX": os.path.join(output_dir, f"{base_name}_DX.wav"),
        "Music": os.path.join(output_dir, f"{base_name}_Music.wav"),
        "Effects": os.path.join(output_dir, f"{base_name}_Effects.wav"),
        "DX_Residual": os.path.join(output_dir, f"{base_name}_DX_Residual.wav"),
    }
    for stem_path in stems.values():
        if not is_existing_file(stem_path):
            _write_silent_wav(stem_path)
    return stems
```

**Step 4: Update `normalize_and_validate_stems`**

Replace the background stem validation block:

```python
if not any(
    is_existing_file(normalized.get(key))
    for key in ("Effects", "Music")
):
    raise FileNotFoundError(
        "Stage 1 missing required background stem (Effects or Music)."
    )
```

**Step 5: Update `select_semantics_source_stem`**

```python
def select_semantics_source_stem(stems):
    if not isinstance(stems, dict):
        return None
    for key in ("Effects", "Music"):
        path = stems.get(key)
        if is_existing_file(path):
            return path
    return None
```

**Step 6: Verify**

```bash
grep -n "Foley\|SFX\|Ambience\|foley\|sfx\|ambience" src/main.py
```
Expected: no output.

**Step 7: Commit**

```bash
git add src/main.py
git commit -m "feat(main): update stem constants and helpers for 3-stem pipeline"
```

---

### Task 3: Update tests — 3-stem mock and assertions

**Files:**
- Modify: `tests/_pipeline_test_utils.py`
- Modify: `tests/test_main_checkpoint.py`

**Step 1: Update mock `run_surgical_pipeline` in `_pipeline_test_utils.py`**

Replace the return dict in the `MikupSeparator.run_surgical_pipeline` stub (lines 52–62):

```python
def run_surgical_pipeline(self, input_path: str, fast_mode: bool = False):
    return {
        "DX": str(Path(self.output_dir) / "dx.wav"),
        "Music": str(Path(self.output_dir) / "music.wav"),
        "Effects": str(Path(self.output_dir) / "effects.wav"),
        "DX_Residual": str(Path(self.output_dir) / "dx_residual.wav"),
    }
```

**Step 2: Update assertion in `test_main_checkpoint.py`**

Replace line 39:
```python
for key in ("DX", "Music", "Effects"):
```

**Step 3: Run tests to confirm passing**

```bash
python -m pytest tests/test_main_checkpoint.py -v
```
Expected: all tests PASS.

**Step 4: Commit**

```bash
git add tests/_pipeline_test_utils.py tests/test_main_checkpoint.py
git commit -m "test: update pipeline mocks and assertions for 3-stem output"
```

---

### Task 4: Update `scripts/download_models.py`

**Files:**
- Modify: `scripts/download_models.py`

**Step 1: Replace content**

```python
#!/usr/bin/env python3
"""Download required models before first pipeline run.

Includes:
- Stage 1: vocals_mel_band_roformer.ckpt (MBR vocal separator)
- Stage 1: model_bs_roformer_ep_317_sdr_12.9755.ckpt (optional DX refinement)
- CDX23 models are auto-downloaded to ~/.cache/mikup/cdx23/ on first run.
- Whisper small (local path loading)
- pyannote diarization dependencies

Usage:
    .venv/bin/python3 scripts/download_models.py
"""

import os
import sys

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS_DIR = os.path.join(PROJECT_ROOT, "models")
sys.path.insert(0, PROJECT_ROOT)

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(PROJECT_ROOT, ".env"), override=True)
except ImportError:
    pass

HF_TOKEN = os.environ.get("HF_TOKEN")

PASS1_MODEL = "vocals_mel_band_roformer.ckpt"
PASS2B_MODEL_CANDIDATES = (
    "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
    "BS-Roformer-Viperx-1297.ckpt",
)


def download_whisper():
    dest = os.path.join(MODELS_DIR, "whisper-small")
    if os.path.exists(os.path.join(dest, "model.bin")):
        print("  whisper-small: already present, skipping.")
        return
    print("  Downloading Systran/faster-whisper-small (~244 MB)...")
    from huggingface_hub import snapshot_download
    os.makedirs(MODELS_DIR, exist_ok=True)
    snapshot_download(repo_id="Systran/faster-whisper-small", local_dir=dest)
    print("  Done -> models/whisper-small/")


def download_pyannote():
    if not HF_TOKEN:
        print("  HF_TOKEN not set in .env - skipping pyannote.")
        return
    from huggingface_hub import snapshot_download
    for repo_id in ["pyannote/segmentation-3.0", "pyannote/speaker-diarization-3.1"]:
        print(f"  Downloading {repo_id} to HF cache...")
        snapshot_download(repo_id=repo_id, token=HF_TOKEN)
        print("  Done.")


def download_separation_models():
    print("  Preloading separation models via audio-separator cache...")
    try:
        from audio_separator.separator import Separator
    except Exception as exc:
        print(f"  audio-separator unavailable ({exc}); skipping.")
        return

    cache_dir = os.path.join(MODELS_DIR, "separation")
    os.makedirs(cache_dir, exist_ok=True)
    separator = Separator(output_dir=cache_dir)

    for model_name in (PASS1_MODEL,) + PASS2B_MODEL_CANDIDATES:
        try:
            separator.load_model(model_name)
            print(f"  Cached: {model_name}")
        except Exception as exc:
            print(f"  Could not preload {model_name}: {exc}")

    print("  Note: CDX23 models auto-download to ~/.cache/mikup/cdx23/ on first run.")


if __name__ == "__main__":
    print("Downloading Mikup models...\n")
    print("[1/3] Stage 1 separation models (MBR + BS-Roformer)")
    download_separation_models()
    print("\n[2/3] faster-whisper (Systran/faster-whisper-small)")
    download_whisper()
    print("\n[3/3] pyannote diarization")
    download_pyannote()
    print("\nAll done. CDX23 models download automatically on first pipeline run.")
```

**Step 2: Commit**

```bash
git add scripts/download_models.py
git commit -m "feat(scripts): update download_models for MBR+CDX23 pipeline"
```

---

### Task 5: Rust — update `dsp/mod.rs` structs and decoder

**Files:**
- Modify: `ui/src-tauri/src/dsp/mod.rs`

**Step 1: Update `STEM_IDS`**

Line 26:
```rust
const STEM_IDS: [&str; 3] = ["dx", "music", "effects"];
```

**Step 2: Update `AudioFrameStemFlags`**

```rust
#[derive(Debug, Clone, Copy, Default)]
pub struct AudioFrameStemFlags {
    pub dx: StemState,
    pub music: StemState,
    pub effects: StemState,
}

impl AudioFrameStemFlags {
    fn from_map(map: &HashMap<String, StemState>) -> Self {
        Self {
            dx: *map.get("dx").unwrap_or(&StemState::default()),
            music: *map.get("music").unwrap_or(&StemState::default()),
            effects: *map.get("effects").unwrap_or(&StemState::default()),
        }
    }

    fn any_solo(self) -> bool {
        self.dx.is_solo || self.music.is_solo || self.effects.is_solo
    }
}
```

**Step 3: Update `StemRuntimeGains` and `StemTargetGains`**

```rust
#[derive(Debug, Clone, Copy)]
struct StemRuntimeGains {
    dx: f32,
    music: f32,
    effects: f32,
}

impl Default for StemRuntimeGains {
    fn default() -> Self {
        Self { dx: 1.0, music: 1.0, effects: 1.0 }
    }
}

#[derive(Debug, Clone, Copy)]
struct StemTargetGains {
    dx: f32,
    music: f32,
    effects: f32,
}

impl StemTargetGains {
    fn from_flags(flags: AudioFrameStemFlags) -> Self {
        let any_solo = flags.any_solo();
        let gain_for = |stem: StemState| -> f32 {
            if any_solo {
                if stem.is_solo { 1.0 } else { 0.0 }
            } else if stem.is_muted && !stem.is_solo {
                0.0
            } else {
                1.0
            }
        };
        Self {
            dx: gain_for(flags.dx),
            music: gain_for(flags.music),
            effects: gain_for(flags.effects),
        }
    }
}
```

**Step 4: Update `AudioFrame`**

```rust
#[derive(Debug, Clone)]
pub struct AudioFrame {
    pub sample_rate: u32,
    pub dialogue_raw: Vec<f32>,
    pub background_raw: Vec<f32>,
    pub dx_raw: Vec<f32>,
    pub music_raw: Vec<f32>,
    pub effects_raw: Vec<f32>,
    pub stem_flags: AudioFrameStemFlags,
    pub static_loudness: Option<AudioFrameStaticLoudness>,
}

impl Default for AudioFrame {
    fn default() -> Self {
        Self {
            sample_rate: 0,
            dialogue_raw: Vec::new(),
            background_raw: Vec::new(),
            dx_raw: Vec::new(),
            music_raw: Vec::new(),
            effects_raw: Vec::new(),
            stem_flags: AudioFrameStemFlags::default(),
            static_loudness: None,
        }
    }
}
```

**Step 5: Update `MikupAudioDecoder` struct and `new()`**

```rust
pub struct MikupAudioDecoder {
    dx: StemStreamDecoder,
    music: StemStreamDecoder,
    effects: StemStreamDecoder,
    frame_size: usize,
    target_sample_rate: u32,
    stem_states: SharedStemStates,
    stem_runtime_gains: StemRuntimeGains,
    gain_step_per_sample: f32,
    pub alignment_mismatch_detected: bool,
}

impl MikupAudioDecoder {
    pub fn new(
        dx_path: impl AsRef<Path>,
        music_path: impl AsRef<Path>,
        effects_path: impl AsRef<Path>,
        stem_states: SharedStemStates,
        target_sample_rate: u32,
        frame_size: usize,
    ) -> Result<Self, AudioDecodeError> {
        if target_sample_rate == 0 {
            return Err(AudioDecodeError::InvalidConfig("target_sample_rate must be > 0"));
        }
        if frame_size == 0 {
            return Err(AudioDecodeError::InvalidConfig("frame_size must be > 0"));
        }

        let dx = StemStreamDecoder::open("dx_raw", dx_path, target_sample_rate)?;
        let music = StemStreamDecoder::open("music_raw", music_path, target_sample_rate)?;
        let effects = StemStreamDecoder::open("effects_raw", effects_path, target_sample_rate)?;

        let resolved_sample_rate = dx.target_sample_rate();
        if music.target_sample_rate() != resolved_sample_rate
            || effects.target_sample_rate() != resolved_sample_rate
        {
            return Err(AudioDecodeError::InvalidConfig(
                "stems resolved to mismatched output sample rates",
            ));
        }

        let fade_samples = ((target_sample_rate as f32 * STEM_FADE_MS) / 1000.0)
            .round()
            .max(1.0);

        Ok(Self {
            dx,
            music,
            effects,
            frame_size,
            target_sample_rate,
            stem_states,
            stem_runtime_gains: StemRuntimeGains::default(),
            gain_step_per_sample: 1.0 / fade_samples,
            alignment_mismatch_detected: false,
        })
    }

    pub fn with_defaults(
        dx_path: impl AsRef<Path>,
        music_path: impl AsRef<Path>,
        effects_path: impl AsRef<Path>,
    ) -> Result<Self, AudioDecodeError> {
        Self::new(
            dx_path,
            music_path,
            effects_path,
            shared_default_stem_states(),
            DEFAULT_TARGET_SAMPLE_RATE,
            DEFAULT_FRAME_SIZE,
        )
    }
```

**Step 6: Update `read_frame`, `drain_tail`, `seek`, `process_frame`, `sum_background_stems`**

`read_frame`:
```rust
pub fn read_frame(&mut self) -> Result<Option<SyncedAudioFrame>, AudioDecodeError> {
    self.dx.fill_until(self.frame_size)?;
    self.music.fill_until(self.frame_size)?;
    self.effects.fill_until(self.frame_size)?;

    if self.dx.is_finished() && self.music.is_finished() && self.effects.is_finished() {
        return Ok(None);
    }

    let mut dx = self.dx.pop_frame(self.frame_size);
    let mut music = self.music.pop_frame(self.frame_size);
    let mut effects = self.effects.pop_frame(self.frame_size);

    if dx.is_empty() && music.is_empty() && effects.is_empty() {
        if self.dx.is_finished() && self.music.is_finished() && self.effects.is_finished() {
            return Ok(None);
        }
        dx = vec![0.0; self.frame_size];
        music = vec![0.0; self.frame_size];
        effects = vec![0.0; self.frame_size];
    }

    let max_len = dx.len().max(music.len()).max(effects.len());
    if max_len > 0
        && (dx.len() < max_len || music.len() < max_len || effects.len() < max_len)
    {
        self.alignment_mismatch_detected = true;
    }

    dx.resize(max_len, 0.0);
    music.resize(max_len, 0.0);
    effects.resize(max_len, 0.0);

    Ok(Some(self.process_frame(dx, music, effects)))
}
```

`drain_tail`:
```rust
pub fn drain_tail(&mut self) -> SyncedAudioFrame {
    let mut dx = self.dx.drain_remaining();
    let mut music = self.music.drain_remaining();
    let mut effects = self.effects.drain_remaining();

    let max_len = dx.len().max(music.len()).max(effects.len());
    dx.resize(max_len, 0.0);
    music.resize(max_len, 0.0);
    effects.resize(max_len, 0.0);

    self.process_frame(dx, music, effects)
}
```

`seek`:
```rust
pub fn seek(&mut self, seconds: f32) -> Result<(), AudioDecodeError> {
    if !seconds.is_finite() || seconds < 0.0 {
        return Err(AudioDecodeError::InvalidConfig(
            "seek seconds must be finite and >= 0",
        ));
    }
    self.dx.seek(seconds)?;
    self.music.seek(seconds)?;
    self.effects.seek(seconds)?;
    Ok(())
}
```

`process_frame`:
```rust
fn process_frame(
    &mut self,
    mut dx: Vec<f32>,
    mut music: Vec<f32>,
    mut effects: Vec<f32>,
) -> SyncedAudioFrame {
    let stem_flags = self.snapshot_stem_flags();
    let target_gains = StemTargetGains::from_flags(stem_flags);

    apply_gain_ramp(
        &mut dx,
        &mut self.stem_runtime_gains.dx,
        target_gains.dx,
        self.gain_step_per_sample,
    );
    let background = sum_background_stems(
        &mut music,
        &mut effects,
        &mut self.stem_runtime_gains,
        target_gains,
        self.gain_step_per_sample,
    );

    SyncedAudioFrame {
        sample_rate: self.target_sample_rate,
        dialogue_raw: dx.clone(),
        background_raw: background,
        dx_raw: dx,
        music_raw: music,
        effects_raw: effects,
        stem_flags,
        static_loudness: None,
    }
}
```

`sum_background_stems` (simplified to 2 stems):
```rust
fn sum_background_stems(
    music: &mut [f32],
    effects: &mut [f32],
    runtime_gains: &mut StemRuntimeGains,
    target_gains: StemTargetGains,
    gain_step_per_sample: f32,
) -> Vec<f32> {
    let len = music.len().max(effects.len());
    let mut mixed = vec![0.0; len];

    for (i, mixed_sample) in mixed.iter_mut().enumerate() {
        let music_sample = apply_gain_step(
            music.get(i).copied().unwrap_or(0.0),
            &mut runtime_gains.music,
            target_gains.music,
            gain_step_per_sample,
        );
        if let Some(slot) = music.get_mut(i) {
            *slot = music_sample;
        }

        let effects_sample = apply_gain_step(
            effects.get(i).copied().unwrap_or(0.0),
            &mut runtime_gains.effects,
            target_gains.effects,
            gain_step_per_sample,
        );
        if let Some(slot) = effects.get_mut(i) {
            *slot = effects_sample;
        }

        *mixed_sample = music_sample + effects_sample;
    }

    mixed
}
```

**Step 7: Build to verify**

```bash
cd ui && cargo build 2>&1 | head -50
```
Expected: compiles clean (no errors about foley/sfx/ambience).

**Step 8: Commit**

```bash
git add ui/src-tauri/src/dsp/mod.rs
git commit -m "feat(dsp): reduce decoder from 5 stems to 3 (dx/music/effects)"
```

---

### Task 6: Rust — update `dsp/scanner.rs` and `lib.rs`

**Files:**
- Modify: `ui/src-tauri/src/dsp/scanner.rs`
- Modify: `ui/src-tauri/src/lib.rs`

**Step 1: Update `CANONICAL_STEMS` in `scanner.rs`**

Line 20:
```rust
pub const CANONICAL_STEMS: [&str; 3] = ["DX", "Music", "Effects"];
```

**Step 2: Update `lookup_stem_path` aliases in `scanner.rs`**

```rust
fn lookup_stem_path<'a>(
    stem_paths: &'a HashMap<String, String>,
    stem: &'static str,
) -> Option<&'a str> {
    stem_paths
        .iter()
        .find_map(|(k, v)| k.eq_ignore_ascii_case(stem).then_some(v.as_str()))
        .or_else(|| {
            let aliases: &[&str] = match stem {
                "DX" => &["dialogue_raw", "dx_raw", "dialogue"],
                "Music" => &["music_raw", "background_raw", "music"],
                "Effects" => &["effects_raw", "effects", "background"],
                _ => &[],
            };
            aliases.iter().find_map(|alias| {
                stem_paths
                    .iter()
                    .find_map(|(k, v)| k.eq_ignore_ascii_case(alias).then_some(v.as_str()))
            })
        })
}
```

**Step 3: Update `stream_audio_metrics` in `lib.rs`**

Find the `stream_audio_metrics` command (around line 780). Replace signature and body:

```rust
#[tauri::command]
async fn stream_audio_metrics(
    app: tauri::AppHandle,
    stream_generation: tauri::State<'_, Arc<AtomicU64>>,
    stem_states: tauri::State<'_, Arc<RwLock<HashMap<String, StemState>>>>,
    dx_path: String,
    music_path: String,
    effects_path: String,
    start_time: f64,
) -> Result<(), String> {
    ensure_safe_argument("DX path", &dx_path)?;
    ensure_safe_argument("Music path", &music_path)?;
    ensure_safe_argument("Effects path", &effects_path)?;
    if !start_time.is_finite() || start_time < 0.0 {
        return Err("start_time must be a finite value >= 0".to_string());
    }

    let my_gen = stream_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let stream_gen_arc = Arc::clone(&*stream_generation);
    let shared_stem_states = Arc::clone(&*stem_states);

    tokio::task::spawn_blocking(move || {
        let mut decoder = MikupAudioDecoder::new(
            &dx_path,
            &music_path,
            &effects_path,
            shared_stem_states,
            DSP_SAMPLE_RATE,
            DSP_FRAME_SIZE,
        )
        .map_err(|e| e.to_string())?;
        // ... rest of function body unchanged from current ...
```

**Step 4: Update `update_stem_state` command in `lib.rs`**

Find the stem_id validation (around line 753):
```rust
if !matches!(normalized.as_str(), "dx" | "music" | "effects") {
    return Err(format!(
        "Invalid stem_id '{stem_id}'. Allowed values: dx, music, effects"
    ));
}
```

**Step 5: Update profile retrieval in `lib.rs` (around line 640)**

```rust
let dx = profiles
    .get("DX")
    .ok_or_else(|| "Scanner did not produce DX profile".to_string())?;
let music = profiles
    .get("Music")
    .ok_or_else(|| "Scanner did not produce Music profile".to_string())?;
let effects = profiles
    .get("Effects")
    .ok_or_else(|| "Scanner did not produce Effects profile".to_string())?;

let lufs_graph = serde_json::json!({
    "DX": dx,
    "Music": music,
    "Effects": effects,
    // Backward-compatible aliases consumed by UI panels.
    "dialogue_raw": dx,
    "background_raw": music,
});
```

**Step 6: Update the "5-stem WAV set" comment (line ~770)**

```rust
/// Stream DSP metrics from the 3-stem WAV set (DX, music, effects) to the frontend.
```

**Step 7: Build to verify**

```bash
cd ui && cargo build 2>&1 | head -50
```
Expected: clean compile.

**Step 8: Commit**

```bash
git add ui/src-tauri/src/dsp/scanner.rs ui/src-tauri/src/lib.rs
git commit -m "feat(rust): update scanner and stream command for 3-stem pipeline"
```

---

### Task 7: TypeScript — types, hooks, App.tsx

**Files:**
- Modify: `ui/src/types.ts`
- Modify: `ui/src/hooks/useDspStream.ts`
- Modify: `ui/src/App.tsx`

**Step 1: Update stem path types in `ui/src/types.ts`**

Find the `DspStemPaths` type (or equivalent) and remove foleyPath/sfxPath/ambiencePath, add effectsPath:
```typescript
export interface DspStemPaths {
  dxPath: string;
  musicPath: string;
  effectsPath: string;
}
```
Also remove any `*_Foley.wav`, `*_SFX.wav`, `*_Ambience.wav` path template strings (around lines 246–248).

**Step 2: Update `DspStreamPayload` in `useDspStream.ts`**

```typescript
interface DspStreamPayload {
  dxPath: string;
  musicPath: string;
  effectsPath: string;
  startTime: number;
}
```
Update the `invoke('stream_audio_metrics', ...)` call to pass `effects_path` instead of `foley_path`, `sfx_path`, `ambience_path`.

**Step 3: Update `resolvePlaybackStemPaths` in `App.tsx`**

```typescript
function resolvePlaybackStemPaths(
  payload: MikupPayload | null,
  inputPath: string | null,
  workspaceDirectory: string | null,
): DspStemPaths {
  const stems = payload?.artifacts?.stem_paths ?? [];

  const payloadDX = stems.find((p) => /_DX\./i.test(p) || /vocals|dialogue/i.test(p));
  const payloadMusic = stems.find((p) => /_Music\./i.test(p) || /instrumental|background|music/i.test(p));
  const payloadEffects = stems.find((p) => /_Effects\./i.test(p) || /effects/i.test(p));

  if (payloadDX && payloadMusic) {
    return {
      dxPath: payloadDX,
      musicPath: payloadMusic,
      effectsPath: payloadEffects ?? '',
    };
  }

  if (inputPath && workspaceDirectory) {
    const filename = inputPath.replace(/^.*[\\/]/, '');
    const baseName = filename.replace(/\.[^/.]+$/, '');
    return {
      dxPath: `${workspaceDirectory}/stems/${baseName}_DX.wav`,
      musicPath: `${workspaceDirectory}/stems/${baseName}_Music.wav`,
      effectsPath: `${workspaceDirectory}/stems/${baseName}_Effects.wav`,
    };
  }

  return { dxPath: payloadDX ?? '', musicPath: payloadMusic ?? '', effectsPath: payloadEffects ?? '' };
}
```

**Step 4: Update `ghostStemPaths` in `App.tsx`**

```typescript
const ghostStemPaths = useMemo(() => {
  const sp = resolvePlaybackStemPaths(payload, inputPath, workspaceDirectory);
  return {
    musicPath: sp.musicPath || undefined,
    effectsPath: sp.effectsPath || undefined,
  };
}, [payload, inputPath, workspaceDirectory]);
```

Also update any destructuring of `ghostStemPaths` later in the component tree to pass `effectsPath` instead of `sfxPath/foleyPath/ambiencePath`.

**Step 5: Verify TypeScript compiles**

```bash
cd ui && npm run build 2>&1 | tail -20
```
Expected: no type errors related to old stem props.

**Step 6: Commit**

```bash
git add ui/src/types.ts ui/src/hooks/useDspStream.ts ui/src/App.tsx
git commit -m "feat(ui): update stem paths from 5 to 3 (dx/music/effects)"
```

---

### Task 8: TypeScript — update UI components

**Files:**
- Modify: `ui/src/components/MetricsPanel.tsx`
- Modify: `ui/src/components/WaveformVisualizer.tsx`
- Modify: `ui/src/components/StemControlStrip.tsx`
- Modify: `ui/src/components/MikupConsole.tsx`

**Step 1: `MetricsPanel.tsx` — remove SFX/Foley/Ambience series**

- Remove `sfxST`, `foleyST`, `ambienceST` from `StemMetrics` interface
- Remove their `useState` entries
- Remove `payloadSfx`, `payloadFoley`, `payloadAmbience` extraction; replace with `payloadEffects`
- Remove Foley/Ambience `linearGradient` defs; add an Effects gradient (use amber or similar)
- Remove SFX/Foley/Ambience `Area` chart components; add an Effects area
- Remove SFX/Foley/Ambience `StreamToggle` components; add Effects toggle
- Remove tooltip rows for those three; add Effects row

**Step 2: `WaveformVisualizer.tsx` — remove old ghost stems**

Find `GHOST_STEMS` array or equivalent (lines ~18–20, ~34–36). Replace:
```typescript
const GHOST_STEMS = [
  { key: 'musicPath', label: 'Music' },
  { key: 'effectsPath', label: 'Effects' },
];
```

**Step 3: `StemControlStrip.tsx` — remove SFX/Foley/Ambience strips**

Replace the 5-stem strip definitions with 3:
```typescript
const STEM_STRIPS = [
  { id: 'dx', label: 'DX', color: 'text-sky-400' },
  { id: 'music', label: 'Music', color: 'text-purple-400' },
  { id: 'effects', label: 'Effects', color: 'text-amber-400' },
];
```

**Step 4: `MikupConsole.tsx` — remove FOLEY/SFX/AMBIENCE log tags**

Remove the tag color entries for FOLEY, SFX, AMBIENCE (lines ~28–29). Add EFFECTS if not present:
```typescript
EFFECTS: { color: 'text-amber-400', ... },
```

**Step 5: Verify TypeScript compiles**

```bash
cd ui && npm run build 2>&1 | tail -20
```
Expected: no type errors.

**Step 6: Commit**

```bash
git add ui/src/components/MetricsPanel.tsx ui/src/components/WaveformVisualizer.tsx \
        ui/src/components/StemControlStrip.tsx ui/src/components/MikupConsole.tsx
git commit -m "feat(ui): remove Foley/SFX/Ambience from components, add Effects"
```

---

### Task 9: Update documentation

**Files:**
- Modify: `docs/SPEC.md`
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `src/llm/director_prompt.md`

**Step 1: Rewrite `docs/SPEC.md` Section 1 and Section 2**

```markdown
## 1. Surgical Separation Pipeline (Stage 1)
All separation follows this hybrid 2-pass architecture.

### Pass 1: MBR Vocal Extraction
- **Model:** `vocals_mel_band_roformer.ckpt` (SDR 12.6) via audio-separator
- **Stems:** `vocals` → DX candidate, `other` → instrumental
- **Rationale:** Specialist vocal model outperforms CDX23's single-pass 3-way split for dialog clarity.

### Pass 2: CDX23 Instrumental Split
- **Model:** CDX23 (Demucs4/DnR) via demucs API
- **Input:** `other` (instrumental) from Pass 1
- **Stems:** `Music`, `Effects` (CDX23's own dialog output is discarded)
- **Models dir:** `~/.cache/mikup/cdx23/` (auto-downloaded on first run)
- **Rationale:** With dialog already removed, CDX23 cleanly splits music vs. effects.

### Pass 2b: DX Refinement (optional)
- **Model:** `BS-Roformer-Viperx-1297` (`model_bs_roformer_ep_317_sdr_12.9755.ckpt`)
- **Action:** Process the Pass 1 vocals stem.
- **Outputs:** `DX` (clean dialogue), `DX_Residual` (residual bleed).
- **Toggle:** Skipped when `fast_mode=True`.

## 2. Canonical Stem Naming
- `DX`: Primary dry dialogue.
- `Music`: Full orchestral/electronic score.
- `Effects`: All non-music, non-dialog audio (hard FX, ambience, foley combined).
- `DX_Residual`: Optional residual from Pass 2b; omitted in fast mode.
```

**Step 2: Update `CLAUDE.md`**

- In "What This Project Is", update stem naming note: `` `DX`, `Music`, `Effects` ``
- In "Stem Dictionary" under Architecture, replace:
```python
{
    "dx":      "stems/..._DX.wav",
    "music":   "stems/..._Music.wav",
    "effects": "stems/..._Effects.wav",
}
```

**Step 3: Update `AGENTS.md`**

Same canonical stem update: `DX`, `Music`, `Effects`.

**Step 4: Update `README.md`**

Update any pipeline description referring to Cinematic Trinity or 5-stem to reflect the hybrid approach and 3-stem output.

**Step 5: Update `src/llm/director_prompt.md`**

Replace the stem list section. Remove SFX, Foley, Ambience as separate items. Merge into:
```
3. **Effects:** All non-music, non-dialog sound: hard FX, movement sounds, and ambience.
```
Remove the "5-Stem LUFS Interplay" heading, replace with "3-Stem LUFS Interplay".

**Step 6: Commit**

```bash
git add docs/SPEC.md CLAUDE.md AGENTS.md README.md src/llm/director_prompt.md
git commit -m "docs: update all references to hybrid 3-stem pipeline"
```

---

### Task 10: Final verification

**Step 1: Run Python tests**

```bash
source .venv/bin/activate && python -m pytest tests/ -v
```
Expected: all pass.

**Step 2: Full Rust build**

```bash
cd ui && cargo build
```
Expected: clean compile, zero warnings about old stem names.

**Step 3: TypeScript lint**

```bash
cd ui && npm run lint
```
Expected: no errors.

**Step 4: Grep for stale references**

```bash
grep -rn "Foley\|SFX\|Ambience\|foley\|sfx\|ambience\|cinematic_trinity\|refine_dialogue\|split_other\|Cinematic.2\|MDX.NET.Cinematic" \
  src/ tests/ scripts/ ui/src/ ui/src-tauri/src/ docs/SPEC.md CLAUDE.md AGENTS.md README.md \
  --include="*.py" --include="*.rs" --include="*.ts" --include="*.tsx" --include="*.md" \
  2>/dev/null | grep -v "docs/plans/"
```
Expected: no output (docs/plans/ archived files excluded).

**Step 5: Final commit**

```bash
git add -A
git commit -m "chore: post-refactor cleanup — verify no stale 5-stem references"
```
