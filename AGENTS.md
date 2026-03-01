## Agent Behavioral Protocol
- **Objective Feedback:** Agents are expected to be critical and realistic. Do not agree with the user for the sake of politeness.
- **Technical Integrity:** If a proposed change or architectural shift is likely to cause regressions, performance issues, or increased technical debt, the agent must voice these concerns clearly.
- **The Single Source of Truth:** All agents (Gemini, Claude, Codex) must strictly adhere to the technical specifications defined in **`docs/SPEC.md`**.
- **No Sycophancy:** Avoid "Great idea!" or "I'd be happy to." Focus on the "why" and "how" of the technical implementation.

## Project Structure
Project Mikup has two code layers:
- `src/`: Python audio pipeline stages orchestrated by `src/main.py`.
- `ui/`: React + TypeScript + Vite frontend with Tauri Rust bridge in `ui/src-tauri/`.

Refer to `docs/SPEC.md` for details on:
- 3-Pass Separation (Stage 1).
- Canonical stem naming (`DX`, `Music`, `SFX`, `Foley`, `Ambience`).
- Platform standards (macOS/WSL2).

## Build, Test, and Development Commands
Run from repo root unless noted:
- `python3 -m venv .venv && source .venv/bin/activate`
- `pip install -r requirements-mac.txt` (macOS) or `pip install -r requirements-cuda.txt` (Linux/CUDA): install backend dependencies.
- `python src/main.py --input "path/to/audio.wav"`: run full backend pipeline.
- `python tests/mock_generator.py`: generate mock stems/transcription.
- `python src/main.py --input dummy --mock`: smoke-test pipeline without heavy ML stages.

Frontend (`cd ui`):
- `npm install`
- `npm run dev`: Vite dev server.
- `npm run tauri dev`: Start the native Tauri app.
- `npm run tauri:wsl`: Start the native Tauri app in WSL2 (fixes graphics issues).
- `npm run build`: TypeScript + production build.
- `npm run lint`: ESLint checks.

## Coding Style & Naming Conventions
Python:
- Follow PEP 8, 4-space indentation, `snake_case` for functions/variables, `PascalCase` for classes.
- Keep stage logic modular by folder (`src/<stage>/...`), avoid cross-stage coupling.

TypeScript/React:
- Components use `PascalCase` filenames (`MetricsPanel.tsx`), hooks/state in `camelCase`.
- Follow ESLint config in `ui/eslint.config.js`; run `npm run lint` before PRs.

## Testing Guidelines
- Primary current validation is smoke testing with mock data.
- For backend changes, run:
  `python tests/mock_generator.py && python src/main.py --input dummy --mock`
- For UI changes, run `cd ui && npm run lint && npm run build`.
- Add new Python tests under `tests/` with `test_*.py` naming.

## Commit & Pull Request Guidelines
- Commit history is minimal; use short, imperative commit subjects (for example: `Add mock DSP regression check`).
- Keep commits focused by area (pipeline, UI, or Tauri bridge).
- PRs should include:
  - Purpose and scope
  - Commands run for validation
  - Linked issue/context
  - UI screenshots/GIFs when frontend behavior changes

## Security & Configuration Tips
- Copy `.env.example` to `.env`; never commit secrets.
- Required secrets include LLM keys and `HF_TOKEN` for diarization.
- Ensure FFmpeg is installed locally before running audio stages.
