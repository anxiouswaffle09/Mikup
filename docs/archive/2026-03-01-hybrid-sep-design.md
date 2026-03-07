# Design: Hybrid Separation Pipeline (3-Stem)

**Date:** 2026-03-01
**Status:** Approved
**Replaces:** MDX-NET Cinematic 2 "Cinematic Trinity" 3-pass pipeline

---

## Problem

CDX23 (Demucs4/DnR) single-pass 3-way separation produces music stems with significant dialog bleed on film content. Its architecture isn't optimised for isolating speech from a complex theatrical mix.

## Solution

Chain a specialist vocal separator before CDX23:

1. `vocals_mel_band_roformer.ckpt` (SDR 12.6) extracts clean dialog first
2. CDX23 then operates on the instrumental residual — an easier 2-class (music vs. effects) problem with no dialog present

Testing on `cts1_ep01_master.wav` confirmed cleaner dialog and music stems with this approach.

---

## New Pipeline

```
Pass 1  vocals_mel_band_roformer.ckpt  (audio_separator)
        original → (vocals)  →  DX candidate
                 → (other)   →  instrumental

Pass 2  CDX23 via demucs API           (demucs.states + demucs.apply)
        instrumental → music
                     → effects
                     → dialog (discarded)

Pass 2b BS-Roformer ep_317             (audio_separator, skipped if fast_mode=True)
        vocals → DX (clean)
               → DX_Residual

Pass 3  REMOVED — HPSS/CLAP effects deconstruction eliminated
```

---

## Canonical Stems (3-stem, down from 5)

| Stem | Source | Notes |
|---|---|---|
| `DX` | MBR vocals (Pass 1), optionally cleaned by Pass 2b | Primary dry dialogue |
| `Music` | CDX23 music output (Pass 2) | Score / score percussion |
| `Effects` | CDX23 effects output (Pass 2) | All non-music, non-dialog audio |
| `DX_Residual` | BS-Roformer residual (Pass 2b) | Optional; omitted in fast_mode |

**Removed:** `Foley`, `SFX`, `Ambience` — merged into `Effects`.

---

## CDX23 Model Storage

- Models stored at `~/.cache/mikup/cdx23/` (configurable via `MIKUP_CDX23_MODELS_DIR` env var)
- Auto-downloaded from GitHub releases on first run via `torch.hub.download_url_to_file`
- High-quality 3-checkpoint ensemble is the default (`high_quality=True`)
- Model IDs: `97d170e1-a778de4a.th`, `97d170e1-dbb4db15.th`, `97d170e1-e41a5468.th`

---

## Affected Files

### Python
- `src/ingestion/separator.py` — rewrite pipeline; remove Pass 3 methods; add `_pass1_mbr_vocal_split`, `_pass2_cdx23_instrumental`; update `CANONICAL_STEMS`
- `src/main.py` — update `CANONICAL_STEM_KEYS`, stem resolution map, mock fallback paths
- `scripts/download_models.py` — remove MDX-NET Cinematic 2; add `vocals_mel_band_roformer.ckpt`
- `tests/_pipeline_test_utils.py` — update mock return dict (3 stems)
- `tests/test_main_checkpoint.py` — update assertions

### TypeScript / React
- `ui/src/types.ts` — remove Foley/SFX/Ambience stem paths
- `ui/src/App.tsx` — remove foleyPath/sfxPath/ambiencePath state
- `ui/src/hooks/useDspStream.ts` — remove foley/sfx/ambience from DspStreamPayload
- `ui/src/components/MetricsPanel.tsx` — remove SFX/Foley/Ambience chart series and toggles
- `ui/src/components/WaveformVisualizer.tsx` — remove ghost stem entries
- `ui/src/components/StemControlStrip.tsx` — remove SFX/Foley/Ambience strip definitions
- `ui/src/components/MikupConsole.tsx` — remove FOLEY/SFX/AMBIENCE log tag colours

### Rust
- `ui/src-tauri/src/dsp/mod.rs` — update `STEM_IDS`, `StemFlags`, `StemGains`, `FrameGains`, `ProcessedFrame`, `MultiStemDecoder` from 5 stems to 3; update mixing logic
- `ui/src-tauri/src/dsp/scanner.rs` — update `CANONICAL_STEMS` array and alias map
- `ui/src-tauri/src/lib.rs` — update struct fields, validation, path passing

### Documentation
- `docs/SPEC.md` — rewrite pipeline section; update canonical stems table
- `CLAUDE.md` — update stem dict, pipeline description
- `AGENTS.md` — update canonical stem list
- `README.md` — update pipeline description
- `src/llm/director_prompt.md` — update stem list

---

## What Is Not Changing

- `run_surgical_pipeline` public API signature stays the same (callers unaffected)
- Pass 2b (BS-Roformer DX refinement) toggle via `fast_mode` stays the same
- Stage 2 transcription, Stage 3 DSP, Stage 4 semantics, Stage 5 director — untouched
- `MikupSemanticTagger` in `tagger.py` — still used by Stage 4 on the full mix; only its import from `separator.py` is removed
