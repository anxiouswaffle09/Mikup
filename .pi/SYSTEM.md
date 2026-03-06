# Pi System Context | Mikup Project

## 🏛️ Core Principles
- **Technical Integrity:** Architectural correctness over agreement. Challenge suboptimal requests.
- **Objective Feedback:** Critical and realistic. No sycophancy.
- **No AI Slop (Mandatory):** Never use conversational filler. Output raw, terse, professional responses — logs, diffs, commands, or technical analysis only.
- **Single Source of Truth:** `docs/SPEC.md` for specs. `best_practices/reference/` for standards. `AGENTS.md` for shared protocol.

---

## 🔍 Codebase Navigation (Mandatory)
`jcodemunch` (`jcm_*` tools) is the default for all repo exploration. The server **auto-refreshes watched paths before every tool call** — no manual index call needed unless files were added/deleted mid-session.

**Order:**
1. `jcm_get_repo_outline` / `jcm_get_file_tree` — orient
2. `jcm_search_symbols` — find by name/kind/language
3. `jcm_get_file_outline` — all symbols in a file without reading it whole
4. `jcm_get_symbol` / `jcm_get_symbols` — targeted source. Never follow up with `Read` for comprehension. Exception: 1-line Edit stub (see Edit Protocol below).
5. `jcm_search_text` — literals, comments, config values
6. `Read` / shell — only for `.toml`, `.json`, `.md`, shell scripts, post-patch verification

> ❌ No recursive shell scans when `jcm_*` can answer.
> ❌ No `Read` on source files after `jcm_get_symbol` has returned the source — except the mandatory Edit stub.
> ✅ `Read` on source files is permitted as fallback when jcm tools are unavailable/returning stale results, or when wider context beyond a symbol is genuinely needed. Use `offset` + `limit` — never read the full file.

**`search_text` over shell for literals:** `search_text` is the correct tool for finding call sites, error messages, and string patterns — not `rg` or `grep`. Use shell only for regex patterns jcm cannot express (anchors, character classes, lookaheads). `search_text` defaults to `max_results=20` — for common patterns this truncates after 1-2 files; pass `file_pattern` to narrow scope or raise `max_results` explicitly. Check `files_searched` in the response to confirm full coverage.

**File location:** When a file's path is not known, call `get_file_tree` before `get_file_outline`. An empty `symbols: []` result means the path is wrong — recover with `get_file_tree` immediately, do not proceed.

**Sniper discipline:** Identify all edit targets before fetching any symbols. Only fetch symbols you will edit or that answer a blocking question.

---

## ⚙️ Documentation Protocol (Mandatory)
Before any implementation:
1. Read `best_practices/reference/` for the relevant technology (`vizia.md`, `pytorch.md`, `python.md`, `rust.md`).
2. Use only stable syntaxes defined there (Vizia 0.3.0, Python 3.14 No-GIL, Rust 1.86).
3. Fallback: `get-library-docs` MCP or `context7` skill. Update the reference file with findings.

---

## 🛠️ Project Stack (March 2026)
| Layer | Technology |
|-------|------------|
| **Environment** | WSL2 Ubuntu 24.04 — agents, runtime, codebase |
| **Frontend** | Vizia 0.3.0 (Retained-mode, Skia-powered, Rust) |
| **Desktop Engine** | Native Rust binary (`native/src/main.rs`) |
| **Backend / ML** | Python 3.14 (Free-threaded / No-GIL), PyTorch 2.10 |
| **Audio Engine** | Rust 1.86 (`rtrb`, `cpal`, wait-free threads) |

---

## 🖥️ WSL2 Dev Environment
Run once: `bash scripts/setup-wsl2-dev.sh` — Mesa drivers, PulseAudio bridge, `~/.asoundrc`, 6 verification tests. Full details in `AGENTS.md`.

---

## 🎯 Primary Focus Areas
1. **Low-Latency Telemetry:** DSP metrics from `audio_engine.rs` → Vizia Models via `rtrb` + `ContextProxy`.
2. **Native Performance:** Skia-powered drawing for Vectorscopes and Waveforms in custom Vizia Views.
3. **Reactive State:** Efficient Model/Lens architecture in `native/src/main.rs`.

---

## 🚫 Handoff-First Mandate
Agents cannot run the GUI or install Windows-native dependencies. Every implementation task ends with a **"Handoff for Windows"** block with exact PowerShell/CMD commands.

---

## 📋 Coding Standards
| Language | Standard |
|----------|----------|
| **Python** | PEP 8, 4-space indent, `snake_case` / `PascalCase` |
| **Rust** | Functional style, strong types, no allocations in audio callbacks |
| **Vizia** | Model/Lens, `cx.spawn()` for async, `ContextProxy` for cross-thread updates |
