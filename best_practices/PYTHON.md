# Best Practices: Python 3.14 (Free-threaded)

Updated as of: March 2, 2026

## Python 3.14 (Stablefoundation)
- **Environment:** Codebase and Runtime in WSL2 (Linux). Use `pathlib.Path` for all file operations.
- **Free-threaded Build (`python-t`):** Use the free-threaded runtime for the Mikup DSP pipeline to achieve 2x–4x speedup on multi-core systems.
- **Thread-Safety:** The GIL is gone. Use explicit `threading.Lock` for shared dictionaries or project states.
- **Concurrency Strategy:** 
  - Prefer `concurrent.futures.ThreadPoolExecutor` over `multiprocessing` for sharing large audio buffers (stems) without IPC overhead.
- **JIT Activation:** Set `PYTHON_JIT=1` in the environment to activate the "Copy-and-Patch" JIT for tight DSP loops.

## Forensic Data Aggregation
The Python backend's primary role is to turn raw high-resolution telemetry into summarized **"Forensic Events."**

### 1. Pacing Metrics (Macro & Micro)
- **Speech Rate:** Syllables per second (including pauses).
- **Articulation Rate:** Syllables per second (excluding pauses).
- **Silence Ratio (%):** Percentage of "negative space" in a given window.
- **nPVI (Normalized Pairwise Variability Index):** Measures rhythmic contrast.
  - *Formula:* $100 \times [\sum |(d_m - d_{m+1}) / ((d_m + d_{m+1})/2)| / (n-1)]$.

### 2. Intelligibility Standards
- **STOI (Short-Time Objective Intelligibility):** Mathematical metric (0.0–1.0) comparing the `DX` envelope against the `Music+Effects` noise.
- **Whisper Confidence (`avg_logprob`):** Use as a linguistic clarity proxy.
- **Detection Logic:** Any section with STOI < 0.6 or `avg_logprob` < -1.0 must be flagged as a **Masking Alert**.

## Machine Learning & Performance
- **Torch 2.10:** Use `weights_only=True` with **Safe Globals** in `bootstrap.py`.
- **NumPy 2.4+:** Treat all audio arrays as immutable after creation to avoid "Copy-on-Write" performance penalties in free-threaded mode.
- **Type Hinting:** Use strict `typing.Annotated` hints to help the JIT generate more efficient machine code.

## Library Standards
- **pystoi v0.3.4+:** For STOI metrics.
- **soundfile v0.13.0+:** For high-speed on-demand multimodal slicing.
- **audio-separator v0.41+:** For Roformer-based dialogue extraction.
- **WhisperX v3.8+:** For phoneme-accurate alignment.
- **google-genai v1.65+:** For the AI Director (multimodal).
