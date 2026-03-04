# Mikup Code Review Fixes

Apply the following 34 fixes to the codebase. Use deep reasoning and step-by-step logic for every change.

## 🔴 CRITICAL
1. `ui/src-tauri/src/dsp/mod.rs:567` vs `dsp/scanner.rs:335` — Mono downmix inconsistency. Fix `mod.rs` to divide by channel count: `let mono = sum / channels as f32; mono.clamp(-1.0, 1.0)`.
2. `src/ingestion/separator.py` — `__main__` block crashes unconditionally. Fix: `msep = MikupSeparator(output_dir=sys.argv[2] if len(sys.argv) > 2 else "/tmp/mikup_stems")`.
3. `src/main.py` — `_read_json_file` silently swallows Pydantic validation errors. Fix: Log the validation failure at `WARNING` level with exception details, return default or raw data safely.
4. `src/main.py` — `_read_json_file` has no lock, `_write_json_file` does. Fix: Acquire `_state_lock` in `_read_json_file` to prevent torn reads under No-GIL.

## 🟡 WARNING
5. `src/main.py` — Non-atomic JSON writes. Fix: Write to `path + ".tmp"`, then `os.replace(tmp_path, path)`.
6. `src/main.py` — `validate_stage_artifacts` mutates disk as side effect. Fix: Remove `_write_json_file` from validation.
7. `src/bootstrap.py` — `check_model_integrity()` called without `versions` in `main.py`. Fix: Call `load_versions()` inside `check_model_integrity` if `versions` is None.
8. `ui/src-tauri/src/lib.rs` — `open_path` opens arbitrary user paths via `xdg-open`. Fix: Validate path exists and reject URIs.
9. `ui/src-tauri/src/lib.rs` — `contains_unsafe_shell_tokens` is incomplete. Fix: Add `$`, `;`, `|`, `&`, `(`, `)`.
10. `ui/src-tauri/src/lib.rs` — `mark_dsp_complete` / `clear_dsp_stage_state` have read-modify-write race. Fix: Add a Tauri-managed `Mutex` for state file modifications.
11. `src/llm/director.py` — `send_message` builds conversation as flat string. Fix: Use proper `genai.types.Content` objects for multi-turn history.
12. `ui/src-tauri/src/dsp/player.rs` — `clear()` spin-wait may not complete. Fix: Increase iterations from 100 to 500.
13. `src/main.py` — `_read_config` uses relative path `data/config.json`. Fix: Use `PROJECT_ROOT / "data" / "config.json"`.
14. `src/transcription/transcriber.py` — `diarize` catches bare `Exception` silently. Fix: Catch `(OSError, RuntimeError, ValueError, ImportError)` specifically.
15. `ui/src-tauri/src/dsp/spectral.rs` & `spatial.rs` — Per-frame Vec allocations. Fix: Pre-allocate buffers in the analyzer structs and reuse them.
16. `src/main.py` — Director exception during report only caught by `finally`. Fix: Add explicit `except` block for `generate_report` failures.

## 🔵 INFO (Apply these as well)
17. Replace f-strings in `logger.info()` with `%s` formatting in `main.py`, `director.py`, `tagger.py`.
18. Refactor `_build_final_payload` in `src/main.py` by breaking it into smaller helper functions.
19. Remove redundant `import numpy as np` and `import torch` from `_pass2_cdx23_instrumental` in `separator.py`.
20. In `cleanup_stems` (`src/main.py`), catch `OSError` instead of bare `Exception`.
21. In `ui/src-tauri/src/lib.rs`, move the `export_ts_bindings` logic strictly to tests, do not run in `run()`.
22. In `ui/src-tauri/src/lib.rs`, add a max buffer size check (~64KB) for `stdout_buf` in `run_python_pipeline`.
23. In `src/semantics/tagger.py`, add `soundfile.LibsndfileError` (or generic audio load exception) handling around `librosa.load`.
24. Ensure `ui/src-tauri/src/lib.rs` clears DSP metrics for ALL upstream stage invalidations if missing.
25. Remove redundant file format checks in `StemStreamDecoder::open` (keep only one robust check).
26. In `ui/src-tauri/src/dsp/player.rs`, increment an `AtomicU64` counter for dropped samples in `push_interleaved_nonblocking`.
27. Fix logging f-string in `src/llm/director.py:90`.
28. Ensure `audio_player` sets `drained` to true in `stream_audio_metrics` error paths to prevent indefinite hangs.
29. Fix `fallback_index` in `transcriber.py` to map to unique speakers rather than unique segments.
30. Note: `drain_tail` does apply gain ramps via `process_frame`. (No code change needed, just verify).
31. In `src/main.py`, modify `update_history` to avoid storing the massive full payload directly in `history.json` (store file reference or summary only).
32. In `src/main.py`, append a random UUID or process ID suffix to the workspace directory name to prevent collisions.
33. Optimize `EbuR128` recreation in `loudness.rs` if possible (or leave as is if unavoidable).
34. Fix `StageInfo.artifacts` type hint vs runtime usage in `src/main.py`.