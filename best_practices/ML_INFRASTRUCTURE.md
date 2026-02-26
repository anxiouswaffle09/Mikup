# Best Practices: Machine Learning Infrastructure

Updated as of: February 26, 2026

## Hugging Face Transformers (v5.2.0)
The v5 series introduces "Multimodal Auto" classes as first-class citizens.

### Key Practices:
- **AutoModelForMultimodalLM:** Use this for models like Qwen2.5-VL or Phi-4-Multimodal that handle audio/image/text simultaneously.
- **Expert implementation:** Use the `experts_implementation` parameter to offload vision/audio/text backends to different VRAM segments.
- **Quantization:** Integrate `torchao` for int4 weight-only quantization to run the pipeline on local hardware with <24GB VRAM.

## PyTorch (v2.10.0)
- **Python 3.13 Support:** Use the latest stable Python 3.13 for improved GIL performance in multi-threaded ingestion.
- **SDPA (Scaled Dot Product Attention):** Explicitly set `attn_implementation="sdpa"` in model loading for a 20-30% speedup on modern GPUs.
- **MPS Optimization:** Improved support for Apple Silicon (Metal Performance Shaders) for local development on macOS.

### Model Loading Snippet:
```python
from transformers import AutoModelForMultimodalLM, TorchAoConfig
import torch

quantization_config = TorchAoConfig("int4_weight_only", group_size=128)
model = AutoModelForMultimodalLM.from_pretrained(
    "OpenGVLab/InternVL3-1B-hf",
    torch_dtype=torch.bfloat16,
    device_map="auto",
    quantization_config=quantization_config,
    attn_implementation="sdpa"
)
```
