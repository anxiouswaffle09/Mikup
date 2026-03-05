# Agent Behavioral Protocol

## 🏛️ Core Principles
- **Objective Feedback:** Agents are critical and realistic. No sycophancy.
- **Technical Integrity:** Architectural correctness over user agreement.
- **No AI Slop (Mandatory):** Agents must NEVER use conversational filler ("Here is the code," "I have updated the file," "Certainly," "Let me know"). Output must be raw, terse, professional, and strictly limited to logs, commands, or technical analysis.
- **Single Source of Truth:** All agents must adhere to the specs in `docs/SPEC.md` and the standards in `best_practices/reference/`.

## ⚙️ Documentation Protocol (Mandatory)
Every agent (Gemini, Claude, Codex) must follow this sequence before any task:
1.  **Read `best_practices/reference/`**: Check the local documentation for the relevant technology (e.g., `react.md`, `tauri.md`, `python.md`).
2.  **Enforce 2026 Standards**: Use only the stable syntaxes defined in those files (React 19, Tailwind v4, Python 3.14 No-GIL).
3.  **Fallback to MCP**: If information is missing from the local reference, use the `get-library-docs` or `resolve-library-id` MCP tools as a secondary option.

## 🛠️ Project Stack (March 2, 2026)
- **Environment**: WSL2 (Linux) agents/runtime; Codebase in Windows mount (`/mnt/d/SoftwareDev/Mikup`).
- **Handoff-First Mandate**: Agents are forbidden from running GUI tasks or Windows-native installs. All implementation tasks must provide a "Handoff for Windows" block with native PowerShell/CMD commands for the user to run.
- **Frontend (Native UI)**: Vizia 0.3.0 (Retained-mode, Skia-powered, Rust).
- **Desktop Engine**: Native Rust binary (`native/src/main.rs`).
- **Backend (ML/DSP)**: Python 3.14 (Free-threaded / No-GIL), PyTorch 2.10 (Safe Globals).
- **Audio Engine (Native)**: Rust 1.86 (Wait-free threads, `rtrb`, `cpal`).

## 📋 Coding Standards
- **Python**: PEP 8, 4-space indent, `snake_case` functions, `PascalCase` classes.
- **React**: `PascalCase` filenames, `camelCase` hooks. No manual `useMemo`.
- **Rust**: Functional style, strong type safety, no allocations in audio callbacks.

## 📦 Commits & PRs
- **Commit Style**: Short, imperative subjects (e.g., `Update Vectorscope to Canvas`).
- **PR Requirements**: Include purpose, validation commands, and documentation cross-references.
