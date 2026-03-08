# Hook Setup Guide

---

## Gemini CLI Hooks (Active)

Two hooks are currently configured for Gemini CLI: a session initializer and a jdocmunch read guard.

### Prerequisites

- jdocmunch must be installed and the project must be indexed (`index_local`) before the read guard will work
- After indexing, `~/.doc-index/local/<ProjectName>.paths.json` must exist — this is the sidecar file the hook reads
- jdocmunch auto-generates the sidecar on every index and incremental update (built into `DocStore.save_index` and `reindex_changed_files`)
- All hook scripts must be executable (`chmod +x`)
- Restart Gemini after any change to `~/.gemini/settings.json`

---

### Hook 1 — SessionStart: Date + Protocol Reminder

Fires at session start, resume, and after `/clear`. Injects today's date and reminds Gemini to follow its protocols if a `GEMINI.md` is present in the project root.

**Script:** `~/.gemini/hooks/session-start.sh`

```sh
#!/bin/sh
DATE=$(date '+%Y-%m-%d')
GEMINI_MD=""
if [ -f "$PWD/.gemini/GEMINI.md" ]; then
  GEMINI_MD=" Refer to .gemini/GEMINI.md and follow your protocols."
elif [ -f "$PWD/GEMINI.md" ]; then
  GEMINI_MD=" Refer to GEMINI.md and follow your protocols."
fi

printf '{"hookSpecificOutput":{"additionalContext":"Today'\''s date is %s.%s"}}' "$DATE" "$GEMINI_MD"
```

**Key facts:**
- `additionalContext` is injected as the first turn in history (interactive) or prepended to the user prompt (headless)
- `SessionStart` is advisory only — `decision` and `continue` fields are ignored, the session always starts
- Checks both `.gemini/GEMINI.md` and `GEMINI.md` at the project root — works for either layout
- No external dependencies, pure shell

---

### Hook 2 — BeforeTool: jdocmunch Read Guard

Fires before every `read_file` call. Checks whether the target file is indexed in jdocmunch by reading the lightweight `.paths.json` sidecar. Blocks full reads on indexed files and redirects Gemini to use `search_sections` → `get_section` instead.

**Script:** `~/.gemini/hooks/before-read-file.sh`

```sh
#!/bin/sh
# Block read_file on files indexed in jdocmunch — redirect to search_sections/get_section.

OUTPUT=$(python3 -c "
import json, sys
from pathlib import Path

try:
    data = json.load(sys.stdin)

    file_path = data.get('tool_input', {}).get('file_path', '')
    if not file_path:
        sys.exit(0)

    doc_index = Path.home() / '.doc-index'
    if not doc_index.exists():
        sys.exit(0)

    for sidecar in doc_index.glob('*/*.paths.json'):
        try:
            with open(sidecar) as f:
                s = json.load(f)
            source_path = s.get('source_path', '')
            doc_paths = s.get('doc_paths', [])
            if not source_path:
                continue
            if not (file_path == source_path or file_path.startswith(source_path + '/')):
                continue
            rel_path = file_path[len(source_path):].lstrip('/')
            if rel_path in doc_paths:
                print('block')
                break
        except Exception:
            continue
except Exception:
    pass
" 2>/dev/null)

if [ "$OUTPUT" = "block" ]; then
    printf '{"decision":"block","reason":"This file is indexed in jdocmunch. Use search_sections to locate the relevant section, then get_section to retrieve its content. This avoids loading the full file into context."}'
fi
exit 0
```

**Key facts:**
- Reads `~/.doc-index/*/*.paths.json` — works across all indexed repos automatically, no hardcoded paths
- Sidecar format: `{ "source_path": "/abs/path", "doc_paths": ["relative/file.md", ...] }`
- Non-indexed files pass through silently — no disruption to normal workflow
- Blocking uses JSON stdout `{"decision":"block","reason":"..."}` with `exit 0` — NOT `exit 2` (exit 2 = hook failure warning, not a clean block)
- `matcher: "read_file"` scopes the hook to read_file calls only — does not fire on every tool call
- Uses `python3` for JSON parsing — available by default on all systems; no external dependencies
- If `~/.doc-index` doesn't exist (jdocmunch not set up), hook exits silently and allows all reads

---

### settings.json Configuration

Add the `hooks` key to `~/.gemini/settings.json`:

```json
"hooks": {
  "SessionStart": [
    {
      "matcher": ".*",
      "hooks": [
        {
          "name": "session-init",
          "type": "command",
          "command": "/home/<user>/.gemini/hooks/session-start.sh"
        }
      ]
    }
  ],
  "BeforeTool": [
    {
      "matcher": "read_file",
      "hooks": [
        {
          "name": "jdocmunch-read-guard",
          "type": "command",
          "command": "/home/<user>/.gemini/hooks/before-read-file.sh"
        }
      ]
    }
  ]
}
```

Replace `<user>` with your actual username. Relative paths are unreliable — always use absolute paths.

---

### Setup Checklist for a New Device

- [ ] Create `~/.gemini/hooks/` directory
- [ ] Write `session-start.sh` and `before-read-file.sh` (contents above)
- [ ] `chmod +x ~/.gemini/hooks/session-start.sh ~/.gemini/hooks/before-read-file.sh`
- [ ] Add `hooks` block to `~/.gemini/settings.json` with correct absolute paths
- [ ] Install and configure jdocmunch MCP server
- [ ] Run `index_local` on the project to generate `~/.doc-index/local/<Project>.paths.json`
- [ ] Restart Gemini
- [ ] Verify with `/hooks` panel — both hooks should appear

---

### Gemini Hook System — Key Gotchas

| Gotcha | Reality |
|--------|---------|
| `exit 2` to block | Use JSON stdout `{"decision":"block"}` with `exit 0` — exit 2 = hook failure |
| Inline command in settings | Unreliable — always use a script file |
| `name` field optional | Required — hook silently ignored without it |
| Hot reload | Must restart Gemini after editing settings.json |
| Tool info via env vars | Comes via stdin as JSON — parse with python3 |
| Matcher is a regex | `"read_file"` matches exactly; `".*"` catches all tools |
| `SessionStart` decision field | Ignored — session always starts regardless |
| Hooks structure | Nested: event → array of matcher groups → each group has a `hooks` array |

---

---

## Claude Code Hooks (Active)

Two hooks are currently configured for Claude Code: a session initializer and a jdocmunch read guard. These mirror the Gemini hooks with format differences specific to the Claude Code hook system.

### Hook 1 — SessionStart: Date + Protocol Reminder

Fires at session start and after `/clear`. Injects today's date and reminds Claude to follow its protocols if a `CLAUDE.md` is present in the project root.

**Script:** `~/.claude/hooks/session-start.sh`

```sh
#!/bin/sh
DATE=$(date '+%Y-%m-%d')
CLAUDE_MD=""
if [ -f "$PWD/CLAUDE.md" ]; then
  CLAUDE_MD=" Refer to CLAUDE.md and follow your protocols."
fi

printf '{"additionalContext":"Today'\''s date is %s.%s"}' "$DATE" "$CLAUDE_MD"
```

**Key facts:**
- Output format is `{"additionalContext":"..."}` — flatter than Gemini's nested `hookSpecificOutput` wrapper
- `SessionStart` is advisory only — the session always starts regardless of hook output
- Checks `CLAUDE.md` at the project root (Claude Code uses a single `CLAUDE.md`, not `.claude/CLAUDE.md`)
- No external dependencies, pure shell

---

### Hook 2 — PreToolUse: jdocmunch Read Guard

Fires before every `Read` call. Checks whether the target file is indexed in jdocmunch by reading the lightweight `.paths.json` sidecar. Blocks full reads on indexed files and redirects Claude to use `search_sections` → `get_section` instead.

**Script:** `~/.claude/hooks/before-read.sh`

```sh
#!/bin/sh
# Block Read on files indexed in jdocmunch — redirect to search_sections/get_section.

OUTPUT=$(python3 -c "
import json, sys
from pathlib import Path

try:
    data = json.load(sys.stdin)

    file_path = data.get('tool_input', {}).get('file_path', '')
    if not file_path:
        sys.exit(0)

    # Allow small-limit reads (Edit stubs) — limit <= 5 lines is never a full-file load
    limit = data.get('tool_input', {}).get('limit', None)
    if limit is not None and limit <= 5:
        sys.exit(0)

    doc_index = Path.home() / '.doc-index'
    if not doc_index.exists():
        sys.exit(0)

    for sidecar in doc_index.glob('*/*.paths.json'):
        try:
            with open(sidecar) as f:
                s = json.load(f)
            source_path = s.get('source_path', '')
            doc_paths = s.get('doc_paths', [])
            if not source_path:
                continue
            if not (file_path == source_path or file_path.startswith(source_path + '/')):
                continue
            rel_path = file_path[len(source_path):].lstrip('/')
            if rel_path in doc_paths:
                print('block')
                break
        except Exception:
            continue
except Exception:
    pass
" 2>/dev/null)

if [ "$OUTPUT" = "block" ]; then
    echo "This file is indexed in jdocmunch. Use search_sections to locate the relevant section, then get_section to retrieve its content. This avoids loading the full file into context." >&2
    exit 2
fi
exit 0
```

**Key facts:**
- Reads `~/.doc-index/*/*.paths.json` — works across all indexed repos automatically, no hardcoded paths
- Allows Edit stub reads (`limit <= 5`) — the Edit tool requires a prior `Read` touch; this exemption prevents the hook from breaking the edit workflow
- Non-indexed files pass through silently — no disruption to normal workflow
- Blocking uses `stderr` message + `exit 2` — opposite of Gemini (which uses JSON stdout + `exit 0`)
- `matcher: "Read"` — Claude Code's Read tool is named `Read`, not `read_file`
- Uses `python3` for JSON parsing — available by default; no external dependencies
- If `~/.doc-index` doesn't exist, hook exits silently and allows all reads

---

### settings.json Configuration

Add the `hooks` key to `~/.claude/settings.json`:

```json
"hooks": {
    "SessionStart": [
        {
            "hooks": [
                {
                    "type": "command",
                    "command": "/home/<user>/.claude/hooks/session-start.sh"
                }
            ]
        }
    ],
    "PreToolUse": [
        {
            "matcher": "Read",
            "hooks": [
                {
                    "type": "command",
                    "command": "/home/<user>/.claude/hooks/before-read.sh"
                }
            ]
        }
    ]
}
```

Replace `<user>` with your actual username. Relative paths are unreliable — always use absolute paths.

---

### Setup Checklist for a New Device

- [ ] Create `~/.claude/hooks/` directory
- [ ] Write `session-start.sh` and `before-read.sh` (contents above)
- [ ] `chmod +x ~/.claude/hooks/session-start.sh ~/.claude/hooks/before-read.sh`
- [ ] Add `hooks` block to `~/.claude/settings.json` with correct absolute paths
- [ ] Install and configure jdocmunch MCP server
- [ ] Run `index_local` on the project to generate `~/.doc-index/local/<Project>.paths.json`
- [ ] Restart Claude Code

---

### Claude Code Hook System — Key Gotchas

| Gotcha | Reality |
|--------|---------|
| `exit 0` to block | **Wrong** — use `exit 2` to block. Exit 0 = allow. Exit 1 = error. |
| JSON stdout to block | **Wrong for Claude** — write reason to stderr, then `exit 2`. Gemini uses JSON; Claude does not. |
| `name` field required | Not required in Claude Code (unlike Gemini where it's mandatory) |
| Hot reload | Must restart Claude Code after editing settings.json |
| Tool info via env vars | Comes via stdin as JSON — parse with python3 (same as Gemini) |
| `matcher` is a regex | `"Read"` matches exactly; `"mcp__jcodemunch__.*"` catches all jcm tools |
| `SessionStart` has no matcher | Unlike `PreToolUse`, `SessionStart` entries have no `matcher` field |
| Edit stubs get blocked | Add `limit <= 5` exemption — without it the hook breaks the Edit workflow |

---

## ⚠️ Deprecated Content (Temporarily)

> The following hooks were implemented but are currently disabled. Kept for reference in case they are re-enabled.

---

### jcodemunch Watched-Path Hook (Deprecated)

Blocked jcodemunch MCP calls when the working directory was not in the watched paths list. Deprecated — path enforcement via hook proved too rigid for the current workflow.

#### Claude Code

**Config file:** `~/.claude/settings.json`

```json
"hooks": {
  "PreToolUse": [
    {
      "matcher": "mcp__jcodemunch__.*",
      "hooks": [
        {
          "type": "command",
          "command": "case \"$PWD\" in \"/path/to/Mikup\"*|\"/path/to/vizia_core\"*|\"/path/to/skia-safe\"*) exit 0 ;; *) echo \"jcodemunch blocked: '$PWD' is not a watched path. Use Read/Grep/Glob instead.\" >&2; exit 2 ;; esac"
        }
      ]
    }
  ]
}
```

**Key facts:**
- Matcher `mcp__jcodemunch__.*` works — Claude Code prefixes MCP tools as `mcp__servername__toolname`
- Exit code **2** blocks. Exit code 1 does NOT block
- Inline shell command works fine in Claude Code
- Restart Claude Code after editing settings.json

#### Gemini CLI

**Script file:** `~/.gemini/hooks/check-jcodemunch-path.sh`

```sh
#!/bin/sh
INPUT=$(cat)
SERVER=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('mcp_context',{}).get('server_name',''))" 2>/dev/null)

if [ "$SERVER" != "jcodemunch" ]; then
  exit 0
fi

case "$PWD" in
  "/path/to/Mikup"*|\
  "/path/to/vizia_core"*|\
  "/path/to/skia-safe"*)
    exit 0
    ;;
  *)
    printf '{"decision":"block","reason":"jcodemunch blocked: %s is not a watched path. Use read_file/Grep/Glob instead."}' "$PWD"
    exit 0
    ;;
esac
```

---

### Pi (pi.dev) — Not Implemented

Pi has a `tool_call` extension hook that fires before any tool runs and can return `{ block: true, reason: "..." }`. MCP servers must first be wrapped using [mcporter](https://github.com/steipete/mcporter).

**References:**
- [extensions.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- [hooks.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/hooks.md)

---

### Codex CLI — Not Supported

No hook system for intercepting MCP tool calls. `execpolicy` only controls shell commands. No equivalent to `PreToolUse` or `BeforeTool`. System prompt instruction is the only available mitigation.

---

### What We Learned the Hard Way

| Mistake | Reality |
|---------|---------|
| `exit 1` to block in Claude Code | Must be `exit 2` |
| `mcp__jcodemunch__.*` matcher in Gemini | Gemini uses bare tool names, matcher never matched |
| Inline command in Gemini settings | Unreliable — use a script file |
| `exit 2` to block in Gemini | Use JSON stdout `{"decision":"block"}` with `exit 0` |
| `$TOOL_NAME` env var in Gemini hook | Tool info comes via stdin JSON, not env vars |
| Assuming settings reload live | Both Claude Code and Gemini require restart |
