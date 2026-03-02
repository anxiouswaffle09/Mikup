# Library Reference: Google GenAI Python SDK (v1)

Updated as of: March 2, 2026

## 1. Syntax & Core Type Reference
### Content & Parts (Standard Payload)
- **`types.Content`**: List of parts with a `role` (user, model).
- **`types.Part`**: Individual element (text, image, audio, tool call).
- **`types.Candidate`**: A single model response.

```python
from google.genai import types

content = types.Content(
    role="user",
    parts=[types.Part.from_text(text="Hello!")]
)
```

### Response Object (Core Methods)
```python
response = client.models.generate_content(...)
print(response.text) # Full textual response
print(response.candidates[0].content.parts[0].text) # Raw part access
```

---

## 2. Model Configuration & Parameters
### `GenerateContentConfig` Reference:
- **`system_instruction`**: Role/persona (String).
- **`temperature`**: Creativity control (0.0 to 1.0).
- **`max_output_tokens`**: Limit on response length.
- **`tools`**: List of callable functions or `types.Tool` declarations.
- **`thinking_config`**: Used for 2.5 Pro (budget/level).

```python
config = types.GenerateContentConfig(
    temperature=0.3,
    max_output_tokens=1024,
    system_instruction="You are a professional audio engineer..."
)
```

---

## 3. File Operations (Multimodal)
### Upload & Lifecycle:
- **`client.files.upload`**: Uploads a local file.
- **`client.files.get`**: Gets file status/metadata.
- **`client.files.delete`**: Deletes a file.

```python
audio_file = client.files.upload(file="master.wav")
# Wait for state == 'ACTIVE'
```

### Context Caching Syntax:
```python
cache = client.caches.create(
    model='gemini-2.0-flash',
    config=types.CreateCachedContentConfig(
        contents=[audio_file],
        ttl='3600s'
    )
)
```

---

## 4. Error Handling & Token Management
### Standard Error Pattern:
```python
from google.api_core import exceptions

try:
    response = client.models.generate_content(...)
except exceptions.InvalidArgument as e:
    print(f"Invalid request: {e}")
```

### Token Counting:
```python
count = client.models.count_tokens(model="gemini-2.0-flash", contents=["Hello!"])
print(f"Total tokens: {count.total_tokens}")
```

---

## 5. Best Practices for Mikup
1. **Flash for Interaction**: Use `gemini-2.0-flash` for DAW tool calls.
2. **Pro for Analysis**: Use `gemini-2.5-pro` with **Thinking Mode** for reports.
3. **Async Streaming**: Use `client.aio.models.generate_content_stream` for UI feedback.
4. **Context Caching**: Use caches for audio files > 30 minutes.
5. **Clean up Files**: Always delete cloud audio files after inference.
