# Repository Guidelines

## Project Structure & Module Organization
Project Mikup has two code layers:
- `src/`: Python audio pipeline stages (`ingestion/`, `transcription/`, `dsp/`, `semantics/`, `llm/`) orchestrated by `src/main.py`.
- `ui/`: React + TypeScript + Vite frontend with Tauri Rust bridge in `ui/src-tauri/`.

Data and artifacts live in `data/`:
- `data/raw/` input audio
- `data/processed/` intermediate stems/transcription
- `data/output/` final payloads (for example `mikup_payload.json`)

Tests/utilities currently live in `tests/` (not a full test suite yet).

## Build, Test, and Development Commands
Run from repo root unless noted:
- `python3 -m venv .venv && source .venv/bin/activate`
- `pip install -r requirements.txt`: install backend dependencies.
- `python src/main.py --input "path/to/audio.wav"`: run full backend pipeline.
- `python tests/mock_generator.py`: generate mock stems/transcription.
- `python src/main.py --input dummy --mock`: smoke-test pipeline without heavy ML stages.

Frontend (`cd ui`):
- `npm install`
- `npm run dev`: Vite dev server.
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
