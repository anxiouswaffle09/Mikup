# Library Reference: PyTorch 2.10

Updated as of: March 2, 2026

## 1. Syntax & Core Type Reference
### `nn.Module` Reference (Standard)
```python
import torch.nn as nn

class MikupNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.conv = nn.Conv1d(1, 16, kernel_size=3)
        self.relu = nn.ReLU()

    def forward(self, x):
        return self.relu(self.conv(x))

model = MikupNet()
model.to("cuda") # Device movement
```

### Tensor Creation & Operations
```python
import torch

x = torch.randn(1, 44100) # Random tensor (batch, samples)
y = torch.tensor([1.0, 2.0, 3.0]) # From list
z = x + y # Element-wise operations
```

---

## 2. Serialization & Security (Safe Globals)
All checkpoint loading must default to `weights_only=True`.

### `add_safe_globals` Reference:
- **`torch.serialization.add_safe_globals`**: Registers types allowed for unpickling.
- **`torch.load(path, weights_only=True)`**: Secure model loading.

```python
import torch
torch.serialization.add_safe_globals([MyModelClass, np.dtype])
state_dict = torch.load("model.pt", weights_only=True)
```

---

## 3. Data Loading & Datasets
### Dataset Reference:
```python
from torch.utils.data import Dataset, DataLoader

class AudioDataset(Dataset):
    def __init__(self, files): self.files = files
    def __len__(self): return len(self.files)
    def __getitem__(self, i): return load_audio(self.files[i])

loader = DataLoader(AudioDataset(files), batch_size=4, shuffle=True)
```

---

## 4. Optimization & Training
### Optimizer Reference:
```python
import torch.optim as optim

optimizer = optim.AdamW(model.parameters(), lr=1e-4, weight_decay=1e-2)
optimizer.zero_grad()
loss.backward()
optimizer.step()
```

### Learning Rate Schedulers:
```python
scheduler = optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=10)
scheduler.step()
```

---

## 5. CUDA & High-Performance Backends
- **`torch.backends.cuda.matmul.allow_tf32 = False`**: IEEE accuracy.
- **`torch.backends.cuda.sdp_kernel`**: Force specific attention engines.
- **`torch.cuda.Stream`**: Non-blocking concurrent execution.

---

## 6. Best Practices for Mikup
1. **Security-First Loading**: Always use `src/bootstrap.py` for safe globals.
2. **Hybrid Accuracy**: Tweak TF32/FP16 based on the separation stage.
3. **Weight Loading Logic**: Detect unsafe globals using `get_unsafe_globals_in_checkpoint`.
4. **No-GIL Threading**: Use `ThreadPoolExecutor` for parallel ML pre-processing.
