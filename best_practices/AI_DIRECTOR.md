# Best Practices: AI Director (LLM Clients)

Updated as of: February 26, 2026

## Google Gemini (Migration to `google-genai`)
The `google-generativeai` package is now deprecated. The project should migrate to the unified `google-genai` SDK.

### Key Practices:
- **Unified Client:** Use `from google import genai`.
- **Gemini 2.0 Flash:** The recommended model for low-latency audio analysis tasks.
- **Multimodal Uploads:** Use `client.files.upload` for long audio files (>10MB) before inference to ensure stability and token efficiency.
- **System Instructions:** Define the "AI Director" persona strictly in the `system_instruction` parameter of the `generate_content` call.

### Snippet:
```python
from google import genai

client = genai.Client(api_key="YOUR_KEY")
response = client.models.generate_content(
    model="gemini-2.0-flash",
    contents=["Analyze this audio script for pacing.", audio_file_uri],
    config={"system_instruction": "You are a professional Audio Drama Director..."}
)
```

## OpenAI (v2.24.0 "Responses API")
OpenAI's Python client v2 introduces the "Responses API" for better type safety and direct model control.

### Key Practices:
- **Parsed Responses:** Use `beta.chat.completions.parse` for strict JSON outputs (essential for Mikup Atomic Events).
- **Audio Native Models:** Utilize models with native audio understanding (e.g., GPT-5.2-audio) to reduce transcription overhead.
- **Streaming:** Use async streaming for real-time director feedback in the UI.

## Anthropic (v0.84.0)
- **MCP (Model Context Protocol):** Leverage MCP to allow Claude to interact directly with the Mikup local DSP pipeline.
- **Prompt Caching:** Use prompt caching for the extensive "Director Prompt" to save on costs and improve latency.
