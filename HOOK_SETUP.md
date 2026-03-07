# jcodemunch Watched-Path Hook Setup

Blocks jcodemunch MCP calls when the working directory is not in the watched paths list.
Prevents stale index reads. Tested and confirmed working on macOS.

---

## Watched Paths

These are the only directories where jcodemunch is allowed:

- `/Users/test/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/vizia_core-0.3.0`
- `/Users/test/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/skia-safe-0.84.0`
- `/Users/test/Documents/Dev Projects/Mikup`

Update these paths to match the WSL2 equivalents before running.

---

## Claude Code

**Config file:** `~/.claude/settings.json`

Add the `hooks` key at the top level:

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
- Exit code **2** blocks. Exit code 1 does NOT block (this cost us a lot of time)
- Inline shell command works fine — no need for a script file
- Restart Claude Code after editing settings.json — changes are not hot-reloaded

---

## Gemini CLI

**Script file:** `~/.gemini/hooks/check-jcodemunch-path.sh`

Create this file and make it executable (`chmod +x`):

```sh
#!/bin/sh
INPUT=$(cat)
SERVER=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('mcp_context',{}).get('server_name',''))" 2>/dev/null)

# Only enforce path restriction for jcodemunch
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

**Config file:** `~/.gemini/settings.json`

Add the `hooks` key at the top level:

```json
"hooks": {
  "BeforeTool": [
    {
      "matcher": ".*",
      "hooks": [
        {
          "name": "jcodemunch-watched-path-check",
          "type": "command",
          "command": "/home/user/.gemini/hooks/check-jcodemunch-path.sh"
        }
      ]
    }
  ]
}
```

**Key facts:**
- Event name is `BeforeTool` (not `PreToolUse` like Claude Code)
- Gemini does NOT prefix MCP tool names — jcodemunch tools arrive as bare names (`list_repos`, `get_file_outline`, etc.). You cannot match on tool name alone.
- Instead, use `matcher: ".*"` to catch all tools and filter inside the script using `mcp_context.server_name` from stdin JSON
- Blocking is done via JSON stdout `{"decision":"block","reason":"..."}` with exit 0 — NOT exit 2 (exit 2 causes a "hook failed" warning instead of a clean block)
- Use a script file, not an inline command — inline commands in Gemini settings proved unreliable
- The `name` field is required in the hook definition
- Gemini passes tool info via stdin as JSON — not environment variables
- Restart Gemini after editing settings.json

---

## What We Learned the Hard Way

| Mistake | Reality |
|---------|---------|
| `exit 1` to block in Claude Code | Must be `exit 2` |
| `mcp__jcodemunch__.*` matcher in Gemini | Gemini uses bare tool names, matcher never matched |
| Inline command in Gemini settings | Unreliable — use a script file |
| `exit 2` to block in Gemini | Use JSON stdout `{"decision":"block"}` with `exit 0` |
| `$TOOL_NAME` env var in Gemini hook | Tool info comes via stdin JSON, not env vars |
| Assuming settings reload live | Both Claude Code and Gemini require restart |

---

## Pi (pi.dev)

**Supported via extensions.** Pi has a `tool_call` extension hook that fires before any tool runs and can return `{ block: true, reason: "..." }` to prevent execution.

**Caveats to resolve before implementing:**
- Pi has no native MCP support. MCP servers must first be wrapped as CLI tools using [mcporter](https://github.com/steipete/mcporter).
- The tool names Pi exposes for jcodemunch are unknown until tested — confirm names before writing the hook matcher.

**Likely implementation shape** (TypeScript extension):

```typescript
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName.startsWith("jcodemunch_")) {
    const watched = [
      "/path/to/Mikup",
      "/path/to/vizia_core",
      "/path/to/skia-safe",
    ];
    if (!watched.some(p => process.cwd().startsWith(p))) {
      return { block: true, reason: `jcodemunch blocked: ${process.cwd()} is not a watched path.` };
    }
  }
});
```

**References:**
- [extensions.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- [hooks.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/hooks.md)
- [tools.ts example](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/tools.ts)

---

## Codex CLI

**Not supported.** Codex CLI has no hook system for intercepting MCP tool calls.

- `execpolicy` exists but only controls shell command execution, not MCP tools
- Pre/post tool hooks are an open feature request, not shipped
- No equivalent to Claude Code's `PreToolUse` or Gemini's `BeforeTool`

The only mitigation is a system prompt instruction. There is no hard enforcement available.
