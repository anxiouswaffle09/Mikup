# Project-First Workspace Model Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove `data/processed/` as a run-time artifact sink; auto-generate a timestamped `Projects/<stem>_<YYYYMMDD_HHMMSS>/` workspace on every CLI run.

**Architecture:** `main.py` reads `data/config.json` for `default_projects_dir`, generates the workspace path when `--output-dir` is absent, and passes it into all stage runners. `separator.py` loses its hardcoded `"data/processed"` default, enforcing that the orchestrator always supplies the path. `data/` strictly holds `history.json` and `config.json`.

**Tech Stack:** Python 3.13, `argparse`, `json`, `datetime`, existing `pytest`/`unittest` test suite in `tests/`.

---

## Pre-Flight

```bash
cd "/Users/test/Documents/Dev Projects/Mikup"
source .venv/bin/activate
python -m pytest tests/ -v --tb=short 2>&1 | tail -20
```

Note which tests pass/fail before you touch anything.

---

### Task 1: Test `_resolve_output_dir` unit function

**Files:**
- Create: `tests/test_workspace.py`

**Step 1: Write the failing test**

```python
# tests/test_workspace.py
import importlib
import json
import re
import sys
import tempfile
import types
from pathlib import Path

# ── stub heavy dependencies so importing src.main is fast ──────────────────
def _install_stubs():
    for mod in ("dotenv", "torch", "src.ingestion.separator",
                "src.transcription.transcriber", "src.semantics.tagger",
                "src.llm.director"):
        if mod not in sys.modules:
            sys.modules[mod] = types.ModuleType(mod)
    dotenv = sys.modules["dotenv"]
    if not hasattr(dotenv, "load_dotenv"):
        dotenv.load_dotenv = lambda: True
    torch_mod = sys.modules["torch"]
    if not hasattr(torch_mod, "cuda"):
        class _Cuda:
            is_available = staticmethod(lambda: False)
            empty_cache = staticmethod(lambda: None)
        class _Backends:
            class mps:
                is_available = staticmethod(lambda: False)
        torch_mod.cuda = _Cuda()
        torch_mod.backends = _Backends()
        torch_mod.serialization = types.SimpleNamespace(add_safe_globals=lambda x: None)

_install_stubs()
if "src.main" in sys.modules:
    del sys.modules["src.main"]
import src.main as main_mod


def test_resolve_output_dir_uses_config_projects_dir(tmp_path):
    """When --output-dir is absent, workspace is created under config's projects dir."""
    projects_dir = tmp_path / "MyProjects"
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps({"default_projects_dir": str(projects_dir)}))

    result = main_mod._resolve_output_dir(
        input_path="/fake/path/my_audio.wav",
        output_dir_flag=None,
        config_path=str(config_path),
    )

    assert result.startswith(str(projects_dir))
    # Workspace dir name: my_audio_YYYYMMDD_HHMMSS
    name = Path(result).name
    assert name.startswith("my_audio_"), f"Expected 'my_audio_...' got {name!r}"
    assert re.search(r"\d{8}_\d{6}$", name), f"No timestamp suffix in {name!r}"


def test_resolve_output_dir_respects_explicit_flag(tmp_path):
    """When --output-dir is passed, it is returned unchanged (as abspath)."""
    explicit = str(tmp_path / "explicit_workspace")
    result = main_mod._resolve_output_dir(
        input_path="/fake/path/audio.wav",
        output_dir_flag=explicit,
        config_path="/nonexistent/config.json",  # should not be read
    )
    assert result == str(Path(explicit).resolve())


def test_resolve_output_dir_falls_back_to_projects_when_no_config(tmp_path, monkeypatch):
    """When config.json is missing, fallback is <repo_root>/Projects/."""
    monkeypatch.setattr(main_mod, "project_root", str(tmp_path))
    result = main_mod._resolve_output_dir(
        input_path="/fake/path/episode.wav",
        output_dir_flag=None,
        config_path=str(tmp_path / "does_not_exist.json"),
    )
    assert result.startswith(str(tmp_path / "Projects"))
    assert "episode_" in Path(result).name
```

**Step 2: Run test to verify it fails**

```bash
cd "/Users/test/Documents/Dev Projects/Mikup"
python -m pytest tests/test_workspace.py -v
```

Expected: `AttributeError: module 'src.main' has no attribute '_resolve_output_dir'`

**Step 3: Implement `_resolve_output_dir` in `src/main.py`**

Add this function after the `_safe_get_mtime` function (around line 423). Also update the `main()` function.

```python
# ── NEW: project-first workspace resolution ─────────────────────────────────

def _read_config(config_path="data/config.json"):
    """Read data/config.json and return its contents as a dict."""
    return _read_json_file(config_path, default={}) or {}


def _resolve_output_dir(input_path, output_dir_flag=None, config_path="data/config.json"):
    """
    Determine the output workspace directory.

    - If `output_dir_flag` is given (user passed --output-dir), use it verbatim.
    - Otherwise, generate a timestamped workspace:
        <default_projects_dir>/<input_stem>_<YYYYMMDD_HHMMSS>/
      where `default_projects_dir` comes from data/config.json, falling back to
      <repo_root>/Projects/.
    """
    if output_dir_flag is not None:
        return os.path.abspath(output_dir_flag)

    config = _read_config(config_path)
    base = config.get("default_projects_dir") or os.path.join(project_root, "Projects")
    stem = os.path.splitext(os.path.basename(input_path))[0] or "project"
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return os.path.join(os.path.abspath(base), f"{stem}_{timestamp}")
```

**Step 4: Wire into `main()` — replace the arg-parsing block**

In `main()`, find the section after `args = parser.parse_args()` (around line 711). Replace the lines that set `args.output_dir` and the subsequent path logic:

Old code (lines 712–720):
```python
args.input = os.path.abspath(args.input)
args.output_dir = os.path.abspath(args.output_dir)

if not os.path.exists(args.input) and not args.mock:
    logger.error(f"Input file {args.input} not found.")
    sys.exit(1)

output_dir = args.output_dir
args.output = args.output or os.path.join(output_dir, "mikup_payload.json")
```

New code:
```python
args.input = os.path.abspath(args.input)

if not os.path.exists(args.input) and not args.mock:
    logger.error(f"Input file {args.input} not found.")
    sys.exit(1)

output_dir = _resolve_output_dir(
    input_path=args.input,
    output_dir_flag=args.output_dir,
)
args.output_dir = output_dir
args.output = args.output or os.path.join(output_dir, "mikup_payload.json")
```

Also change the `--output-dir` argparse default from `"data/processed"` to `None`:
```python
parser.add_argument("--output-dir", type=str,
    help="Directory for intermediate stage artifacts (default: auto-generated Projects workspace)",
    default=None)
```

**Step 5: Run tests**

```bash
cd "/Users/test/Documents/Dev Projects/Mikup"
python -m pytest tests/test_workspace.py -v
```

Expected: All 3 tests PASS.

**Step 6: Run full test suite to check for regressions**

```bash
python -m pytest tests/ -v --tb=short
```

Expected: No new failures. (Existing tests always pass `--output-dir` explicitly, so they are unaffected.)

**Step 7: Commit**

```bash
git add src/main.py tests/test_workspace.py
git commit -m "feat(workspace): auto-generate timestamped Projects/ workspace when --output-dir absent"
```

---

### Task 2: Decouple `MikupSeparator` from hardcoded default

**Files:**
- Modify: `src/ingestion/separator.py:47`

**Step 1: Verify tests pass before the change**

```bash
python -m pytest tests/ -v --tb=short
```

**Step 2: Remove the default from `MikupSeparator.__init__`**

In `src/ingestion/separator.py`, find line 47:
```python
def __init__(self, output_dir="data/processed"):
```

Change to:
```python
def __init__(self, output_dir):
```

That's the only change. `main.py` already passes `output_dir=os.path.join(output_dir, "stems")` explicitly (line 781). The test stub in `_pipeline_test_utils.py` already has no default.

**Step 3: Run the test suite**

```bash
python -m pytest tests/ -v --tb=short
```

Expected: All tests still pass.

**Step 4: Commit**

```bash
git add src/ingestion/separator.py
git commit -m "fix(separator): require output_dir explicitly — remove hardcoded data/processed default"
```

---

### Task 3: Update `CLAUDE.md` documentation

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Update "Running the Pipeline" section**

Find the existing note about `--output-dir`. It currently says default is `data/processed`. Update the relevant block to:

```markdown
### Running the Pipeline
```bash
# Run on a real audio file — workspace auto-created under Projects/
python src/main.py --input "path/to/audio.wav"

# Run in mock mode (no real audio/ML needed — uses pre-built test stems)
python src/main.py --input dummy --mock

# Specify a custom output directory (overrides auto-workspace)
python src/main.py --input "path/to/audio.wav" --output-dir "Projects/my_custom_workspace"
```

**Step 2: Update the "Key Architecture Notes" data layout description**

Find the existing layout note. Replace or add after the mock mode note:

```markdown
- **Project-First Workspaces**: Each pipeline run creates a self-contained project
  directory under `Projects/<stem>_<YYYYMMDD_HHMMSS>/`. All stems, transcripts,
  metrics, and the final `mikup_payload.json` live there. Pass `--output-dir` to
  override.
- **Global data/**: `data/` strictly holds `history.json` (project index) and
  `config.json` (app settings, including `default_projects_dir`). It no longer
  accumulates intermediate pipeline artifacts.
```

**Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): update workspace model — Projects/ auto-workspace, data/ is global only"
```

---

### Task 4: Update `docs/SPEC.md`

**Files:**
- Modify: `docs/SPEC.md`

**Step 1: Add Workspace Layout section**

Append at the end of `docs/SPEC.md`:

```markdown
## 5. Workspace Layout

Every pipeline run produces a self-contained project directory.

### Auto-Generated Workspace (default)
When `--output-dir` is not passed, `main.py` reads `default_projects_dir` from
`data/config.json` (fallback: `<repo_root>/Projects/`) and generates:

```
Projects/
  <input_stem>_<YYYYMMDD_HHMMSS>/
    stems/           ← raw separator WAV outputs
    data/
      stage_state.json
      stems.json
      transcription.json
      dsp_metrics.json
      semantics.json
      .mikup_context.md
    mikup_payload.json
    mikup_report.md     ← written only if AI Director runs
```

### Global State (`data/`)
`data/` is reserved for machine-level state only:
- `data/history.json` — ordered index of all processed projects (last 50).
- `data/config.json` — settings: `default_projects_dir`, future preferences.

`data/processed/`, `data/raw/`, `data/output/` are legacy paths; do not create
new artifacts there.
```

**Step 2: Commit**

```bash
git add docs/SPEC.md
git commit -m "docs(spec): add workspace layout section — Projects/ auto-workspace standard"
```

---

### Task 5: Update `README.md`

**Files:**
- Modify: `README.md`

**Step 1: Find and update the pipeline run section**

Search for any mention of `data/processed` in `README.md`:
```bash
grep -n "data/processed\|output-dir\|output_dir" README.md
```

For each occurrence, update the description to reflect the new `Projects/` workspace model. If there's a "Running" or "Usage" section, update it to match the CLAUDE.md example above.

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): update pipeline usage — auto Projects/ workspace model"
```

---

### Task 6: Final integration smoke test

**Step 1: Run the full test suite one last time**

```bash
cd "/Users/test/Documents/Dev Projects/Mikup"
python -m pytest tests/ -v --tb=short
```

Expected: All tests pass.

**Step 2: Manually verify auto-workspace creation**

```bash
python src/main.py --input dummy --mock 2>&1 | head -5
ls Projects/
```

Expected: A new timestamped directory appears under `Projects/`.

**Step 3: Verify `data/` is clean**

```bash
ls data/
```

Expected: Only `config.json`, `history.json`, and legacy dirs (`output/`, `processed/`, `raw/` may still exist from before but nothing new was written there).

**Step 4: If all good — no extra commit needed (each task was committed individually)**
