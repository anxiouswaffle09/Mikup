# Design: Project-First Workspace Model

**Date:** 2026-03-02
**Status:** Approved (auto-proceed)

## Problem

Every CLI run drops artifacts into `data/processed/`, creating a single shared mutable workspace. This:
- Prevents the UI from cleanly identifying and loading individual projects.
- Creates "ghost files" if the separator or another component falls back to its own hardcoded default.
- Blurs the distinction between global config/history and per-project data.

## Solution: Timestamped Project Workspaces

### Global (`data/`)
Strictly for machine-level state:
- `data/history.json` — ordered index of all processed projects.
- `data/config.json` — app settings, including `default_projects_dir`.

### Local (`Projects/<name>_<timestamp>/`)
100% of per-run artifacts:
```
Projects/
  cts1_ep01_master_20260302_143000/
    stems/           ← separator outputs
    data/
      stems.json
      transcription.json
      dsp_metrics.json
      semantics.json
      stage_state.json
      .mikup_context.md
    mikup_payload.json
    mikup_report.md
```

## Changes

### 1. `src/main.py`
- `--output-dir` default: `"data/processed"` → `None`.
- New helper `_resolve_output_dir(args)`:
  - If `--output-dir` is explicitly passed, use it (backward-compat escape hatch).
  - Otherwise: read `default_projects_dir` from `data/config.json` (fallback: `Projects/`), generate `<projects_dir>/<stem>_<YYYYMMDD_HHMMSS>/`.
- `--output` (payload path) still defaults to `<output_dir>/mikup_payload.json`.
- `update_history()` keeps `data/history.json` as its target (global).

### 2. `src/ingestion/separator.py`
- `MikupSeparator.__init__(self, output_dir="data/processed")` → `__init__(self, output_dir)`.
- No logic change; all callers already pass the value explicitly.

### 3. Documentation
- **`CLAUDE.md`**: Update "Running the Pipeline" section, data layout table, architecture notes.
- **`README.md`**: Update workspace description (if present).
- **`docs/SPEC.md`**: Add a "Workspace Layout" section.

## Non-Goals
- No change to how the Tauri UI discovers or loads projects (it reads history.json).
- No migration of existing `data/processed/` content.
- No change to stage logic, stem names, or model configuration.
