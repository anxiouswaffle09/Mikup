# Best Practices: Machine Learning Infrastructure

Updated as of: March 2, 2026

## Machine Learning & Performance
- **Environment Context:** Codebase and Agents/Runtime are unified in WSL2 (Linux). Ensure CUDA/DirectML acceleration is correctly mapped from WSL2 to the Windows host GPU.
- **PyTorch Security (Torch 2.4/2.10+):** Use `weights_only=True` with **Safe Globals** in `bootstrap.py`.
- **Mandatory Procedure:**
  1.  **Strict Weights Loading:** All `torch.load` calls should default to `weights_only=True`.
  2.  **Bootstrap Registration:** Use `torch.serialization.add_safe_globals()` in `src/bootstrap.py` to register exactly the classes needed by our pipeline (e.g., `HTDemucs`, `numpy.dtype`).
  3.  **No Environment Overrides:** The `TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD` environment variable is **strictly forbidden**.

## Hybrid Separation (The "Mikup Mix")
For high-fidelity audio dramas, a two-pass separation strategy is mandatory to capture both dialogue clarity and cinematic scale.

### The Strategy:
- **Pass 1 (Roformer):** Use `model_bs_roformer_ep_317_sdr_12.9755.ckpt` strictly for **Dialogue** (`DX`).
- **Pass 2 (CDX23):** Use `h_demucs_cdx23` for **Cinematic Stems** (`Music`, `Effects`).
- **3-Stem Hybrid Standard:** All pipelines must converge on this high-fidelity triplet:
  - `DX`: Primary Dialogue (clean).
  - `Music`: Orchestral/Electronic score.
  - `Effects`: All non-music/non-dialogue sounds.
- **Alignment:** Stems must be phase-aligned before diagnostic playback to avoid comb filtering in the DAW.

## Hugging Face Transformers (v5.2.0)
The v5 series introduces "Multimodal Auto" classes as first-class citizens.

### Key Practices:
- **AutoModelForMultimodalLM:** Use for Qwen2.5-VL or Phi-4-Multimodal for audio/text fusion.
- **Quantization:** Use `torchao` for `int4_weight_only` quantization on consumer hardware (<16GB VRAM).
- **SDPA:** Explicitly set `attn_implementation="sdpa"` for a 30% speedup on modern GPUs.
