---
name: pre-implementation-research
description: Use when about to implement any feature, before writing any code or creating any file — even when the user says research is done, design is locked, or to skip docs.
---

# Pre-Implementation Research

## Core Principle

Documentation is not optional prep — it contains API gotchas, project conventions, and technology-specific constraints that cannot be reconstructed from existing code patterns alone. Skipping it produces code that compiles but violates project standards or uses wrong APIs.

## The Protocol (Rigid — No Exceptions)

**Step 1 — jdocmunch first:**
```
jdm_list_repos         → confirm local/Mikup is indexed
jdm_search_sections    → find existing specs for the feature
jdm_get_section(s)     → read full content of relevant sections
```

**Step 2 — Technology reference:**
```
jdm_search_sections(doc_path="best_practices/reference/<tech>.md")
jdm_get_section        → read the relevant API/pattern sections
```
Relevant files: `vizia.md`, `rust.md`, `python.md`, `pytorch.md`

**Step 3 — Only then:** orient with jcm (`get_file_outline`, `get_symbols`) and write code.

## Red Flags — Stop Immediately

These mean you skipped the protocol:

- You called `get_file_outline` on an existing view before calling `jdm_search_sections`
- You started `Write` without having read at least one jdocmunch section
- You used an existing view as your only reference for APIs
- You haven't called `jdm_list_repos` yet this session

## Rationalization Table

| What you're thinking | Reality |
|---|---|
| "The user already did the research" | The user researched the *design*. You need the *API constraints* — those live in `best_practices/reference/`, not in the conversation. |
| "We've been planning this for weeks" | Planning sessions don't cover Vizia's `from_argb` vs `from_rgba` gotcha. Docs do. |
| "I can learn the patterns from existing views" | Existing views may have their own bugs or pre-date a standard. The reference is ground truth. |
| "The design is locked, docs won't change it" | Docs don't change the design — they constrain the implementation. |
| "It's just a quick implementation" | Wrong API calls produce bugs that take longer to fix than the doc check took. |
| "search_sections returned nothing useful" | That means the feature is new — check the technology reference file even harder. |

## What the Research Catches

From project history — violations that would have been caught by docs-first:
- Using `Color::from_rgba` (doesn't exist) instead of `Color::from_argb(a,r,g,b)`
- Missing `path.close()` before `canvas.draw_path` on filled shapes
- Using `cx.spawn()` without `ContextProxy` for cross-thread updates
- Skia `Paint` not being reset between draw calls (shared mutable state)

## Minimum Acceptable Research

Even under time pressure, the minimum before writing a single line:
1. One `search_sections` call on jdocmunch for the feature
2. One `get_section` from `best_practices/reference/` for the primary technology

Total time: ~2 tool calls. Never skip both.
