#!/usr/bin/env python3
"""
Persistent stdin/stdout REPL for MikupDirector.

Protocol (newline-delimited JSON):
  Rust → Python stdin:  {"text": "<user message>"}\n
  Python → Rust stdout: {"tool": "<name>", ...}\n        (zero or more, during tool execution)
                        {"type": "response", "text": "..."}\n  (final reply)
                        {"type": "ready"}\n                    (once, on startup)
  Python → Rust stderr: logging output (ignored by Rust)

WORKSPACE_DIR env var must point to the workspace folder containing mikup_payload.json.
"""
import json
import logging
import os
import sys

logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)

logger = logging.getLogger(__name__)


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def main() -> None:
    workspace_dir = os.environ.get("WORKSPACE_DIR", "").strip()
    payload_path: str | None = None
    if workspace_dir:
        candidate = os.path.join(workspace_dir, "mikup_payload.json")
        if os.path.exists(candidate):
            payload_path = candidate
        else:
            logger.warning("mikup_payload.json not found at %s", candidate)

    # Deferred import keeps startup logging quiet until after the ready signal.
    from src.llm.director import MikupDirector  # noqa: PLC0415

    director = MikupDirector(
        payload_path=payload_path,
        workspace_dir=workspace_dir or None,
    )

    _emit({"type": "ready"})

    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue

        try:
            msg = json.loads(raw_line)
            user_text: str = msg.get("text", "")
        except json.JSONDecodeError:
            user_text = raw_line

        if not user_text:
            continue

        try:
            reply = director.send_message(user_text)
        except Exception as exc:  # noqa: BLE001
            logger.exception("Director send_message raised an exception")
            reply = f"Director error: {exc}"

        _emit({"type": "response", "text": reply or "Unable to generate a response."})


if __name__ == "__main__":
    main()
