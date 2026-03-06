# jCodeMunch AutoRefresher

## What This Is

A modification to the local `jcodemunch-mcp` MCP server that automatically runs
an incremental index refresh on watched folders **before every tool call** that
reads the index (`search_symbols`, `get_symbol`, `get_file_outline`, etc.).

This guarantees the index is never stale mid-session, regardless of whether the
agent remembered to call `jcm_index_folder` at session start. It fires on every
task, not just at session boundaries.

**Skipped for:** `index_folder`, `index_repo`, `invalidate_cache` — the agent
called those explicitly, no need to pre-refresh.

**Cooldown:** Paths are not re-indexed more than once per `cooldown_secs`
(default 0 — refresh on every tool call). Incremental indexing on unchanged
files is just filesystem stat checks — typically < 50 ms — so this adds
negligible latency. Set higher (e.g. 30) only if latency becomes noticeable on
very large repos.

---

## Files Modified / Created

| File | Purpose |
|------|---------|
| `~/MCPs/jcodemunch-mcp/src/jcodemunch_mcp/server.py` | Added `AutoRefresher` class + hooks in `call_tool` |
| `~/.code-index/autorefresh.json` | Per-machine watched-path config |

The install is **editable** (`pip install -e .`), so editing `server.py` takes
effect on the next process start — no reinstall needed.

---

## Config File

**Location:** `~/.code-index/autorefresh.json`

```json
{
  "_comment": "jCodeMunch AutoRefresher config. Edit paths for your machine.",
  "cooldown_secs": 0,
  "paths": [
    "/absolute/path/to/your/project",
    "/absolute/path/to/vizia_core-0.3.0",
    "/absolute/path/to/skia-safe-0.84.0"
  ]
}
```

**Fields:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `paths` | `string[]` | `[]` | Absolute paths to watch. Supports `~`. |
| `cooldown_secs` | `number` | `0` | Min seconds between refreshes of the same path. `0` = refresh on every tool call (recommended). |

Paths are also **auto-registered at runtime**: any successful `index_folder`
call adds that path to the watched set for the lifetime of the server process.
On restart it reads the config file again, so add permanent paths there.

---

## Applying Changes After Editing server.py

Kill all running jcodemunch-mcp processes. Each CLI respawns them automatically
on the next tool call, picking up the new code:

```bash
pkill -f jcodemunch-mcp
```

No reinstall required. No CLI restart required.

---

## Setting Up on macOS

### 1. Locate your jcodemunch-mcp install

```bash
# Find the server binary
which jcodemunch-mcp 2>/dev/null || find ~ -name "jcodemunch-mcp" -path "*/.venv/*" 2>/dev/null | head -5
```

The source lives one level up from `.venv/` — that is your editable install root.

### 2. Confirm it is an editable install

```bash
# Should print {"dir_info": {"editable": true}, ...}
find ~/.venv -name "direct_url.json" | xargs grep -l "jcodemunch" 2>/dev/null | xargs cat
# Or if installed elsewhere:
find /path/to/jcodemunch-mcp/.venv -name "direct_url.json" | xargs cat
```

If it is **not** editable, reinstall it:

```bash
cd /path/to/jcodemunch-mcp
.venv/bin/pip install -e .
```

### 3. Apply the server.py patch

The `AutoRefresher` class and the two hook points in `call_tool` need to be
added to `server.py`. The easiest way: copy the modified file from the WSL2
machine, or apply the diff manually.

The three changes are:

**a) Imports block** — add `import time` alongside the existing imports.

**b) After the imports, before `server = Server(...)`** — insert the full
`AutoRefresher` class (copy verbatim from the WSL2 `server.py`), plus:
```python
auto_refresher = AutoRefresher()
```

**c) In `call_tool`, immediately after `storage_path = ...`** — add:
```python
if name not in _INDEX_TOOLS:
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, auto_refresher.maybe_refresh, storage_path)
```

**d) After the `index_folder` result** — add:
```python
if result.get("success"):
    auto_refresher.register_path(arguments["path"])
```

### 4. Create the config file

```bash
mkdir -p ~/.code-index
```

Create `~/.code-index/autorefresh.json`. On macOS the Cargo registry path has
the same structure but may use a different registry hash. Find yours:

```bash
# Find vizia_core in your Cargo registry
find ~/.cargo/registry/src -name "vizia_core-*" -type d 2>/dev/null
find ~/.cargo/registry/src -name "skia-safe-*" -type d 2>/dev/null
```

Then write the config with those paths:

```json
{
  "_comment": "jCodeMunch AutoRefresher config.",
  "cooldown_secs": 0,
  "paths": [
    "/Users/yourname/Projects/Mikup",
    "/Users/yourname/.cargo/registry/src/index.crates.io-XXXX/vizia_core-0.3.0",
    "/Users/yourname/.cargo/registry/src/index.crates.io-XXXX/skia-safe-0.84.0"
  ]
}
```

### 5. Configure each CLI

**Claude Code** — add to `~/.claude/settings.json` (or the project-level
`.claude/settings.json`):
```json
{
  "mcpServers": {
    "jcodemunch": {
      "command": "/path/to/jcodemunch-mcp/.venv/bin/jcodemunch-mcp"
    }
  }
}
```

**Gemini CLI** — add to `~/.gemini/settings.json`:
```json
{
  "mcpServers": {
    "jcodemunch": {
      "command": "/path/to/jcodemunch-mcp/.venv/bin/jcodemunch-mcp",
      "args": []
    }
  }
}
```

**Codex** — add to `~/.codex/config.toml`:
```toml
[mcp_servers.jcodemunch]
command = "/path/to/jcodemunch-mcp/.venv/bin/jcodemunch-mcp"
```

### 6. Kill running processes to apply

```bash
pkill -f jcodemunch-mcp
```

### Verifying it works

Enable debug logging to confirm refreshes fire:

```bash
JCODEMUNCH_LOG_LEVEL=DEBUG /path/to/.venv/bin/jcodemunch-mcp --log-file /tmp/jcm.log
```

Then in another terminal, watch the log:
```bash
tail -f /tmp/jcm.log | grep autorefresh
```

You should see lines like:
```
autorefresh: watching /path/to/Mikup
autorefresh: refreshing /path/to/Mikup
autorefresh: /path/to/Mikup — changed=0 new=0 deleted=0
```

---

## Tuning

| Scenario | Recommendation |
|----------|---------------|
| Default | `cooldown_secs: 0` — always fresh, ~50ms overhead |
| Rapid tool calls feel slow | Increase `cooldown_secs` to 30–60 |
| Very large monorepo (10k+ files) | Set `cooldown_secs: 30`; incremental stat is still fast but adds up |
| Dep paths (vizia, skia) rarely change | Leave at 0; unchanged files are just stat checks |
