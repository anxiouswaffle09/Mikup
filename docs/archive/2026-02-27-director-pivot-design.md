# Project Mikup: Agentic DAW (Tool-Calling Chat) Implementation Plan

**Date:** February 27, 2026
**Objective:** Transform the `AIBridge` from a static context viewer into an interactive "Agentic DAW" where an LLM (Gemini/Claude) can control the playback and analyze the mix using specialized function calls (Tools).

---

## Phase 1: Tool Schema Definition
We must define the "API" that the AI Agent is allowed to use. These tools map directly to our Rust DSP and playback commands.

1.  **Playback Tools:**
    *   `seek(time_secs: f32)`: Jumps the playhead and updates the live meters.
    *   `play()` / `pause()`: Controls the native audio engine.
2.  **Diagnostic Tools:**
    *   `get_current_state()`: Returns momentary LUFS, Phase, and Masking flags for the current time.
    *   `get_events(event_type?: string)`: Returns a list of diagnostic markers (Clipping, Masking) from the payload.
    *   `get_transcript(query?: string, time?: f32)`: Searches or retrieves text context.

---

## Phase 2: The Agentic Backend (Python Sidecar)
We will leverage the existing `MikupDirector` logic but pivot it from "Report Generation" to "Chat & Tool Execution."

1.  **Persistent Agent Session:** 
    *   Modify `src/llm/director.py` to support an interactive session (maintaining chat history).
    *   Initialize the Gemini 2.0 Flash client with the Tool definitions.
2.  **The RPC Bridge:**
    *   When the Agent decides to call a tool (e.g., `seek`), the Python script outputs a structured JSON "Tool Call" to stdout.
    *   The Tauri Rust backend intercepts this output, executes the corresponding Rust function (e.g., `player.seek()`), and returns the result back to Python as a "Tool Response."

---

## Phase 3: The Interactive AI Bridge (React UI)
Rework `ui/src/components/AIBridge.tsx` to be a professional-grade chat interface.

1.  **Chat UI:** 
    *   Implement a scrollable message history.
    *   Add a loading state with "Agent is thinking..." or "Agent is analyzing mix..." indicators.
    *   Support Markdown rendering for the Agent's technical explanations.
2.  **Action Feedback:** 
    *   If the agent uses a tool (like `seek`), show a small badge in the chat: `[Agent seeked to 12.5s]`.

---

## Phase 4: Full Integration (The Loop)
1.  **Tauri Command `send_agent_message(text)`:** 
    *   Spawns/Communicates with the Python agent.
    *   Handles the recursive "Tool Call -> Execute -> Respond" loop.
2.  **Context Injection:**
    *   The Agent is always provided with the `.mikup_context.md` so it understands the DAW philosophy and architecture before it starts chatting.

---

## Execution Order
1.  **[Codex]** Define the JSON Tool Schema and update `src/llm/director.py` to handle tool calls.
2.  **[Claude]** Build the React Chat UI in `AIBridge.tsx`.
3.  **[Codex/Claude]** Wire the Tauri "Tool Interceptor" that links Python's tool requests to Rust's DAW commands.
