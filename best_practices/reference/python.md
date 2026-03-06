# Language Reference: Python 3.14 (Free-threaded)

Updated as of: March 2, 2026

## 1. Syntax & Performance Reference
*(... See previous version for threading/No-GIL logic ...)*

---

## 2. 🚫 Anti-AI Slop (Python 3.14)
The No-GIL era demands new patterns. AI models often generate legacy "GIL-think."

**Environment Note:** Codebase and Runtime are native to WSL2 (Linux). Always use `pathlib.Path` for cross-platform safety.

| Legacy/Slop Pattern | Modern Standard (2026) | Why? |
| :--- | :--- | :--- |
| `ProcessPoolExecutor` | **`ThreadPoolExecutor`** | With No-GIL, threads provide true parallelism without IPC overhead. |
| `os.path` manipulation | **`pathlib.Path`** | Standard for type-safety and cross-platform (WSL2/macOS). |
| `isinstance` cascades | **`match-case`** | Faster and more readable for routing DSP events. |
| Raw `dict` for Mikups | **`dataclass(slots=True)`** | Mandatory memory optimization for high-density diagnostic streams. |
| `Union[A, B]` / `List[T]` | **`A | B` / `list[T]`** | Native 3.10+ syntax is cleaner and works better with JIT. |
| Global variables | **`threading.Lock`** | Mandatory for all shared mutable state in No-GIL mode. |

---

## 3. Structural Pattern Matching (`match-case`)
```python
match event:
    case Mikup(type="DX", volume=v) if v < -30:
        handle_silent_dialogue()
    case Mikup(type="SFX"):
        route_to_diagnostic_buffer()
```

---

## 4. Best Practices for Mikup
1. **Immutable Stems**: Set `array.flags.writeable = False` before sharing across threads.
2. **Strict Typing**: Use `type` statements (PEP 695) for complex DSP payload aliases.
3. **Async for I/O**: Use `asyncio` for Director chat; use `ThreadPoolExecutor` for ML compute.
