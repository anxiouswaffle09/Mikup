# AI Director Cleanup & Static Summary Pivot

**Date:** 2026-02-27
**Status:** Approved (user-specified)

## Context

The AI Director feature is pivoting from interactive chat to a static "Mikup Report" generator. The existing `DirectorChat.tsx` component has been deleted. The backend already generates reports; this change aligns naming, fixes the report filename, and adds a read-only report display in the UI.

## Findings

| Area | Current State | Required State |
|---|---|---|
| Python `STAGE_CHOICES` | `"director"` ✅ | `"director"` |
| Python `emit_progress` stage ID | `"AI_DIRECTOR"` | `"DIRECTOR"` |
| Rust stage validation | `"director"` ✅ | `"director"` |
| TS `PipelineStageId` | `'AI_DIRECTOR'` | `'DIRECTOR'` |
| TS `PIPELINE_STAGES[4].id` | `'AI_DIRECTOR'` | `'DIRECTOR'` |
| Report filename | `mikup_payload_report.md` | `mikup_report.md` |
| `DirectorChat` references in App.tsx | None ✅ | None |
| AIBridge `ai_report` display | Clipboard-only | Rendered read-only section |
| `.mikup_context.md` generation | Working ✅ | Working |

## Changes

1. **`src/main.py`**: Change `emit_progress("AI_DIRECTOR", ...)` → `emit_progress("DIRECTOR", ...)` (2 calls). Change report filename to `mikup_report.md` in `output_dir`.
2. **`ui/src/types.ts`**: `'AI_DIRECTOR'` → `'DIRECTOR'` in `PipelineStageId`.
3. **`ui/src/App.tsx`**: `id: 'AI_DIRECTOR'` → `id: 'DIRECTOR'` in `PIPELINE_STAGES`.
4. **`ui/src/components/AIBridge.tsx`**: Add a collapsible read-only "AI Director Report" section that renders `payload.ai_report` as plain text (no external markdown lib needed — use line-level rendering).
5. **Verification**: No DirectorChat imports; context bridge already correct.
