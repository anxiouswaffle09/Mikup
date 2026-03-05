# Best Practices: AI Director (LLM Clients)

Updated as of: March 5, 2026

## Read-Only Research Focus (The Forensic Loop)
The AI Director is strictly a **Forensic Analyst** and **Creative Partner**. It is forbidden from modifying audio or project state. Its role is to observe, diagnose, and explain.

### Key Practices:
- **Always-On Playhead Context:** The Rust UI must silently append the current `playhead_time` to every message sent to the AI Director. This ensures the AI always has situational awareness of "where" the user is looking.
- **On-Demand Multimodal Slicing:** To prevent massive uploads, the system uses **On-Demand Slicing**.
  - *Strategy:* The Rust UI sends timestamp coordinates (`start_time`, `end_time`). The Python backend slices a tiny WAV snippet and uploads it to the multimodal LLM (Gemini 2.0 Flash).
  - *Benefit:* Allows the AI to "listen" to specific anomalies (e.g., "What is that 60Hz hum at [01:20:500]?").
- **3-Stem Context (DX, Music, Effects):** All prompts must align with the canonical 3-stem architecture.
- **Move-Only Timestamps:** All LLM responses must use the `[MM:SS:ms]` format. The Vizia UI turns these into clickable buttons that **move the playhead ONLY**.
- **Async Streaming:** Use the Python `google-genai` async client to stream tokens to the UI.

## Google Gemini (v2.0+ "Flash Multimodal")
...
- **System Instructions:** Defined in `src/llm/director_prompt.md`. Strictly enforce the "Forensic Analyst" persona and the prioritization of user-specified timestamps over the automatic `playhead_time`.

## Security & Path Sandboxing (Mandatory)
...
```python
# Validation Helper Snippet
abs_path = os.path.abspath(path)
if os.path.commonpath([self.workspace_dir, abs_path]) != self.workspace_dir:
    raise PermissionError("Path traversal attempted.")
```

## OpenAI (v2.24+ "Structured Outputs")
- **Strict JSON:** Use `response_format={"type": "json_schema", ...}` for generating the `mikup_payload.json` to ensure zero schema drift.
- **Reasoning Models:** Use o1-mini for high-level "Narrative Structure Analysis" where pacing and subtext are more complex than basic audio metrics.
