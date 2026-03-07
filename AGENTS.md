# Agent Behavioral Protocol

## 🏛️ Core Principles
- **Objective Feedback:** Critical and realistic. No sycophancy.
- **Technical Integrity:** Architectural correctness over user agreement.
- **No AI Slop (Mandatory):** NEVER use conversational filler ("Here is the code," "I have updated the file," "Certainly," "Let me know"). Output must be raw, terse, professional — logs, commands, diffs, or technical analysis only.
- **Single Source of Truth:** Adhere to specs in `docs/SPEC.md` and standards in `best_practices/reference/`.

---

## 🚀 Index Freshness (Automatic)
The jcodemunch MCP server **auto-refreshes all watched paths before every non-indexing tool call** — this is handled server-side and requires no agent action. Watched paths: Mikup project, `vizia_core-0.3.0`, `skia-safe-0.84.0`. Config: `~/.code-index/autorefresh.json`. Cooldown: 30 s.

**When to refresh manually:** After adding/deleting/moving source files mid-session, or when results look stale, call `jcm_index_folder(incremental=true)` explicitly. Otherwise the server handles it.

---

## 🧭 Codebase Discovery Protocol (Mandatory)
`jcodemunch-mcp` is the default tool for all repo exploration and code navigation.

1. **Scope first:** `get_repo_outline` or `get_file_tree` to orient before opening files.
2. **Search semantically:** `search_symbols` for functions, types, methods, classes. `search_text` for comments, config values, prose, and broad content discovery. For punctuation-heavy exact string literals (macro invocations `Slider::new(`, call-site enumeration `SeekTo(`, log strings), use `search_text(exact=True)` — case-sensitive native match, no shell needed. `rg -n -F` is the fallback only when jcm is unavailable or for regex patterns jcm cannot express.
3. **Read symbols directly:** `get_symbol` / `get_symbols` return full source — **never follow up with a `Read` of the same file**. The returned source is ground truth.
4. **Targeted reads only:** When context beyond a symbol is needed, use the `line` number from jcm output: `Read(path, offset=<line-5>, limit=30)`. Never read a full file. Never do sequential expanding reads to reconstruct a file.
5. **Shell is secondary:** Use `rg`, `sed`, direct `Read` only for non-indexed targets (`.md`, `.toml`, `.json`, shell scripts) or post-patch verification. Shell regex tools are a last resort for patterns `search_text` cannot express. **`search_text` truncation:** check `total_hits` in every response — if a `warning` field is present, results are truncated; rerun with `exhaustive=True` or `offset` to page before drawing conclusions.
6. **Wiring verification:** `find_constructors` / `find_callers` / `find_references` / `find_field_reads` / `find_field_writes` — use to verify a symbol is actually instantiated or called in production. Before claiming a struct/type is wired, call `find_constructors(type_name, production_only=True)`. Zero production hits = not wired, regardless of whether the symbol exists. Cross-ref tools require the repo to have been indexed after the jcm upgrade (`refs.json` must exist), have strongest coverage for Rust and Python, and may return coverage warnings for unsupported languages. If multiple in-repo symbols share the same short name, `find_*` may withhold merged results and return candidates instead.

> ❌ Never open `.rs` / `.py` / `.ts` source files with `Read` to understand structure.
> ❌ Never `Read` a file after `get_symbol` has already returned its source.
> ❌ Never start with broad recursive shell scans when `jcm_*` can answer semantically.
> ❌ Never use regex shell scans when fixed-string `rg -F` or `search_text` would answer the question more directly.

**File location:** When a file's path is not known, call `get_file_tree` before `get_file_outline`. An empty `symbols: []` result means the path is wrong — recover with `get_file_tree` immediately, do not proceed.

**Sniper discipline:** Identify all edit targets before fetching any symbols. Only fetch symbols you will edit or that answer a blocking question.

---

## 🧭 Documentation Discovery Protocol (Mandatory)
`jdocmunch-mcp` (`jdm_*` tools) is the default for all project documentation (repo name: `local/Mikup`). The unit of access is **section**, not file.

1. `jdm_list_repos` — confirm what doc sets are indexed (repo: `local/Mikup`)
2. `jdm_get_toc_tree` or `jdm_get_document_outline` — orient to structure, locate relevant specs
3. `jdm_search_sections` — find by query; **returns summaries only, not full content**
4. `jdm_get_section` / `jdm_get_sections` — fetch full content of specific sections

**Section ID format:** `{repo}::{doc_path}::{slug}#{level}`
- Example: `local/Mikup::docs/ARCHITECTURE.md::audio-engine#2`
- IDs returned by `jdm_get_toc_tree`, `jdm_get_document_outline`, and `jdm_search_sections`

**Priority rule:** When a doc is in the index, **always use jdm tools first** — never `Read` documentation files. Check `jdm_list_repos` at the start of any doc-heavy task.

**Key rules:**
- `jdm_search_sections` returns summaries only — always follow up with `jdm_get_section` to get content
- Use `jdm_get_sections` (batch) instead of repeated `jdm_get_section` calls for related sections
- Narrow `jdm_search_sections` with `doc_path` to avoid cross-document noise when the file is known
- `verify: true` on `jdm_get_section` checks whether content has drifted since indexing

**Read fallback:** Use `Read` only for small files not in the index or when exact line numbers are needed for `replace`.

**Sniper discipline:** Identify the relevant document and section before fetching content. Use `jdm_search_sections` to locate concepts before retrieving.

**Stale index:** `jdm_delete_index` → `jdm_index_local` to force re-index.
**Auto-refresh:** jdocmunch refreshes indexes before every tool call — no manual re-index at session start.

---

## ⚙️ Documentation Protocol (Mandatory)
Before any implementation or refactor:
1. Use **jdocmunch** to explore relevant documentation in `docs/` and `best_practices/`.
2. Read `best_practices/reference/` for the relevant technology (`vizia.md`, `pytorch.md`, `python.md`, `rust.md`).
3. Use only stable syntaxes defined there (Vizia 0.3.0, Python 3.14 No-GIL, Rust 1.86).
4. If local reference is insufficient: `get-library-docs` MCP or `context7` skill as fallback. Update the reference file with any new findings.

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
Mesa and ALSA→PulseAudio are not installed by default on Ubuntu 24.04. Run once:
```bash
bash scripts/setup-wsl2-dev.sh
```
Installs Mesa GPU drivers, PulseAudio bridge, writes `~/.asoundrc`, runs 6 verification tests. If `/dev/dri/` is missing post-install: `wsl --shutdown` from PowerShell, then re-run.

**Known limitations (not bugs):**
- PulseAudio latency: ~30–80 ms — acceptable for dev, not for production latency testing.
- GPU via D3D12→OpenGL translation — 120 fps telemetry may stutter under load.

---

## 🚫 Handoff-First Mandate
Agents run in WSL2 and **cannot** execute GUI tasks or Windows-native installs. Every implementation task must end with a **"Handoff for Windows"** block:
```powershell
cargo run --bin mikup-native
```

---

## 📋 Coding Standards
| Language | Standard |
|----------|----------|
| **Python** | PEP 8, 4-space indent, `snake_case` functions, `PascalCase` classes |
| **Rust** | Functional style, strong type safety, no allocations in audio callbacks |
| **Vizia** | Model/Lens architecture, `cx.spawn()` for async, `ContextProxy` for cross-thread updates |

---

## 📦 Commits & PRs
- **Commit style:** Short imperative subjects (`Update Vectorscope to Canvas`).
- **PR requirements:** Purpose, validation commands, documentation cross-references.
