# Best Practices: AI Director (LLM Clients)

Updated as of: March 2, 2026

## Interactive Tool-Calling (The DAW Loop)
The AI Director has evolved from a "Batch Report Generator" to a "Real-Time Creative Partner" inside the DAW.

### Key Practices:
- **Mikup Control Protocol (MCP):** Define tool-calling schemas that allow the Director to interact with the playhead and mixer.
  - *Example Tool:* `jump_to_mikup(timestamp_ms)` or `solo_stem(stem_id)`.
- **Context Preservation:** Maintain a "Project State" in the system prompt that includes the currently loaded stems and their detected LUFS/RT60 metadata.
- **Async Streaming:** Use the Python `google-genai` or `openai` async clients to stream "Director Thoughts" to the UI while waiting for tool execution.

## Google Gemini (v1.65+ "Live Integration")
- **Gemini 2.0 Flash:** The primary model for low-latency, real-time "Creative Direction."
- **Audio Native Inference:** For complex "Acoustic Diagnosis," prefer sending the direct audio buffer (via `client.files.upload`) rather than just the transcript.
- **System Instructions:** Strictly define the "Creative Director" persona in `system_instruction` to avoid "hallucinated compliance."

## Security & Path Sandboxing (Mandatory)
All file-related tool calls (e.g., `export_diagnostic_clip`) must validate requested paths using the `_is_path_safe(path)` helper in the `Director` base class.

```python
# Validation Helper Snippet
abs_path = os.path.abspath(path)
if os.path.commonpath([self.workspace_dir, abs_path]) != self.workspace_dir:
    raise PermissionError("Path traversal attempted.")
```

## OpenAI (v2.24+ "Structured Outputs")
- **Strict JSON:** Use `response_format={"type": "json_schema", ...}` for generating the `mikup_payload.json` to ensure zero schema drift.
- **Reasoning Models:** Use o1-mini for high-level "Narrative Structure Analysis" where pacing and subtext are more complex than basic audio metrics.
