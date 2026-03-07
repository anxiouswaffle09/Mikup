# jcodemunch MCP — Improvements

**Date:** 2026-03-06
**Status:** Implemented
**Shipped order:** truncation + pagination -> cross-references -> exact match

---

## Background

This document started as a plan for three gaps in jcodemunch:

1. Search truncation was easy to miss.
2. There was no static wiring verification.
3. Punctuation-heavy literal searches still required `rg -n -F`.

Those improvements are now implemented in the local jcodemunch server used for
Mikup.

---

## What Shipped

The local server now exposes 16 tools:

- `index_repo`
- `index_folder`
- `list_repos`
- `get_file_tree`
- `get_file_outline`
- `get_symbol`
- `get_symbols`
- `search_symbols`
- `invalidate_cache`
- `search_text`
- `get_repo_outline`
- `find_references`
- `find_callers`
- `find_constructors`
- `find_field_reads`
- `find_field_writes`

The shipped behavior includes:

- hard truncation warnings in `search_symbols` and `search_text`
- `total_hits`, `offset`, and `exhaustive` support in search responses
- `search_text(exact=True)` for raw case-sensitive substring matches
- `refs.json` cross-reference indexes built during indexing
- `find_*` APIs for callers, constructors, references, and field access
- test vs production reference counts
- ambiguity protection for short-name collisions via candidate returns
- coverage warnings when xref support does not exist for a repo language
- incremental backfill when an old index exists but `refs.json` is missing

---

## Improvement 1 — Truncation + Pagination + Exhaustive

**Status:** Shipped

### Implemented outcome

`search_symbols` and `search_text` now return:

- `total_hits`
- `offset`
- `_meta.truncated`
- `_meta.exhaustive`
- a top-level `warning` when results are truncated

`search_text` also supports `exact=True`, which performs a raw case-sensitive
substring scan over cached file content.

### Notes

- No re-index is required for these search features.
- Agents should treat any top-level truncation warning as incomplete coverage
  and rerun with `offset` or `exhaustive=True`.

---

## Improvement 2 — Cross-References + Wiring Verification

**Status:** Shipped

### Implemented outcome

During indexing, jcodemunch now runs a second AST pass and stores cross-reference
data in a per-repo `refs.json` file. The server exposes:

- `find_callers`
- `find_constructors`
- `find_references`
- `find_field_reads`
- `find_field_writes`

Responses include:

- `total_refs`
- `production_refs`
- `test_refs`
- per-reference file and line data
- candidate declarations when short-name ambiguity would otherwise conflate
  results
- coverage warnings for unsupported repo languages

### Storage impact

- `INDEX_VERSION` remained `2`
- cross-references are stored separately in `refs.json`
- old indexes do not require a schema invalidation bump; if `refs.json` is
  missing, the next full reindex or incremental refresh backfills it

### Current limitations

- xref coverage is strongest for Rust and Python
- unsupported languages return coverage warnings rather than pretending support
  exists
- dynamic dispatch remains a static-analysis blind spot
  examples: `dyn Trait`, `cx.emit()`, event-bus wiring
- ambiguous short-name queries may return candidates instead of merged results

### Post-rebuild reference counts

After the March 6, 2026 clean rebuild:

| Repo | Symbols | Refs |
|---|---:|---:|
| `local/Mikup` | 550 | 7562 |
| `local/vizia_core-0.3.0` | 1664 | 21949 |
| `local/skia-safe-0.84.0` | 4166 | 22439 |
| `local/jcodemunch-mcp` | 471 | 3065 |

---

## Improvement 3 — Exact Match Mode

**Status:** Shipped

### Implemented outcome

`search_text(exact=True)` now handles punctuation-heavy exact literals such as:

- `LufsGraphView::new(`
- `SeekTo(`
- `cx.emit(`
- exact enum variants
- exact log strings

This keeps most literal searches inside jcodemunch instead of forcing a shell
fallback.

---

## What We Are Still Not Building

| Proposal | Reason to skip |
|---|---|
| Entrypoint reachability tracing | Dynamic dispatch makes static reachability too misleading in the Vizia architecture. |
| Generic xref support claims for every language | Better to fail honestly with coverage warnings than pretend parity where extraction is not implemented. |
| Separate exhaustive scan mode | Covered by `exhaustive=True` in search tools. |

---

## Files That Actually Changed

```
src/jcodemunch_mcp/
├── parser/
│   ├── __init__.py
│   └── extractor.py
├── storage/
│   └── index_store.py
├── tools/
│   ├── find_references.py
│   ├── index_folder.py
│   ├── index_repo.py
│   ├── search_symbols.py
│   └── search_text.py
├── server.py
└── tests/
    └── test_refs.py
```

`find_callers`, `find_constructors`, `find_references`, `find_field_reads`, and
`find_field_writes` are implemented through the shared
`src/jcodemunch_mcp/tools/find_references.py` module rather than separate tool
files.
