# Best Practices: Python 3.14 (Free-threaded)

Updated as of: March 2, 2026

## Python 3.14 (Stablefoundation)
- **Hybrid Environment:** Codebase in Windows (`/mnt/d/SoftwareDev/Mikup/`); Runtime in WSL2 (Linux). Use `pathlib.Path` for all file operations.
- **Free-threaded Build (`python-t`):** Use the free-threaded runtime for the Mikup DSP pipeline to achieve 2x–4x speedup on multi-core systems.
- **Thread-Safety:** The GIL is gone. Use explicit `threading.Lock` for shared dictionaries or project states.
- **Concurrency Strategy:** 
  - Prefer `concurrent.futures.ThreadPoolExecutor` over `multiprocessing` for sharing large audio buffers (stems) without IPC overhead.
- **JIT Activation:** Set `PYTHON_JIT=1` in the environment to activate the "Copy-and-Patch" JIT for tight DSP loops.

## Machine Learning & Performance
- **Torch 2.10:** Use `weights_only=True` with **Safe Globals** in `bootstrap.py`.
- **NumPy 2.4+:** Treat all audio arrays as immutable after creation to avoid "Copy-on-Write" performance penalties in free-threaded mode.
- **Type Hinting:** Use strict `typing.Annotated` hints to help the JIT generate more efficient machine code.

## Library Standards
- **audio-separator v0.41+:** For Roformer-based dialogue extraction.
- **WhisperX v3.8+:** For phoneme-accurate alignment.
- **google-genai v1.65+:** For the AI Director (multimodal).
