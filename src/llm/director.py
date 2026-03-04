import os
import json
import logging
from pathlib import Path
from google import genai
from google.genai import types

logger = logging.getLogger(__name__)

PAYLOAD_START_DELIMITER = "BEGIN_MIKUP_PAYLOAD_JSON"
PAYLOAD_END_DELIMITER = "END_MIKUP_PAYLOAD_JSON"

class MikupDirector:
    """
    Stage 5: The AI Director.
    Takes the structured Mikup JSON payload and generates human-readable production notes.
    Using the new google-genai SDK (v1.0.0+).
    """
    def __init__(self, payload_path: str | None = None, workspace_dir: str | None = None):
        api_key = os.getenv("GEMINI_API_KEY")
        if api_key:
            self.client = genai.Client(api_key=api_key)
            # Use gemini-2.0-flash for efficiency or gemini-2.0-pro-exp for maximum depth
            self.model_id = 'gemini-2.0-flash'
        else:
            self.client = None
            logger.warning("GEMINI_API_KEY not found in environment. Stage 5 will be skipped.")
        self._history: list[types.Content] = []
        self.payload_path = str(Path(payload_path).resolve()) if payload_path else None
        env_workspace = os.getenv("WORKSPACE_DIR")
        resolved_workspace = (
            workspace_dir
            or env_workspace
            or (str(Path(self.payload_path).parent) if self.payload_path else None)
            or os.getcwd()
        )
        self.workspace_dir = str(Path(resolved_workspace).resolve())

    def load_prompt(self):
        prompt_path = Path(__file__).parent / 'director_prompt.md'
        try:
            with open(prompt_path, "r", encoding="utf-8") as f:
                return f.read()
        except OSError as exc:
            logger.error("Failed to load director prompt template: %s", exc)
            return ""

    def generate_report(self, payload: dict):
        """
        Send payload to LLM and get the Markdown report.
        """
        if not self.client:
            logger.warning("LLM client not configured. Skipping AI report generation.")
            return None

        prompt_template = self.load_prompt()
        if not prompt_template:
            return None

        # Insert payload inside explicit delimiters
        payload_str = json.dumps(payload, indent=2)
        payload_block = (
            f"{PAYLOAD_START_DELIMITER}\n"
            f"{payload_str}\n"
            f"{PAYLOAD_END_DELIMITER}"
        )
        
        # Determine how to insert into prompt
        if "[PASTE JSON HERE]" in prompt_template:
            final_prompt = prompt_template.replace("[PASTE JSON HERE]", payload_block)
        else:
            final_prompt = prompt_template + "\n\n" + payload_block

        try:
            logger.info(f"Sending payload to AI Director ({self.model_id})...")
            # Using system_instruction for the persona part if prompt is split correctly
            # For simplicity here, we send as a single prompt unless we refactor director_prompt.md
            response = self.client.models.generate_content(
                model=self.model_id,
                contents=final_prompt
            )
        except Exception as exc:
            logger.error("Failed to generate report from LLM: %s", exc)
            return None

        report_text = getattr(response, "text", None)
        if not isinstance(report_text, str) or not report_text.strip():
            logger.error("LLM returned an empty response; discarding report.")
            return None

        return report_text.strip()

    def send_message(self, user_text: str) -> str:
        """Send a message in the interactive conversation, maintaining history."""
        if not self.client:
            return "AI Director unavailable."

        user_content = types.Content(
            role="user",
            parts=[types.Part.from_text(text=user_text)],
        )
        self._history.append(user_content)

        try:
            response = self.client.models.generate_content(
                model=self.model_id,
                contents=self._history,
            )
        except Exception as exc:
            logger.error("send_message: LLM call failed: %s", exc)
            return f"Director error: {exc}"

        reply_text = getattr(response, "text", None)
        if not isinstance(reply_text, str) or not reply_text.strip():
            logger.error("send_message: LLM returned an empty response.")
            return "AI Director returned an empty response."

        reply_text = reply_text.strip()
        assistant_content = types.Content(
            role="model",
            parts=[types.Part.from_text(text=reply_text)],
        )
        self._history.append(assistant_content)
        return reply_text

    def _is_path_safe(self, path: str) -> bool:
        if not isinstance(path, str) or not path.strip():
            return False
        abs_path = str(Path(path).resolve())
        return Path(abs_path).is_relative_to(self.workspace_dir)

    def _resolve_stem_path(
        self,
        stem_name: str,
        requested_path: str | None = None,
        payload: dict | None = None,
    ) -> str | None:
        def _resolve_candidate(path_value: str) -> str:
            expanded = str(Path(path_value).expanduser())
            if Path(expanded).is_absolute():
                return str(Path(expanded).resolve())
            return str((Path(self.workspace_dir) / expanded).resolve())

        if isinstance(requested_path, str) and requested_path.strip():
            requested_abs = _resolve_candidate(requested_path)
            if not self._is_path_safe(requested_abs):
                logger.warning(
                    "Rejected unsafe requested stem path outside workspace: %s",
                    requested_abs,
                )
                return None
            if Path(requested_abs).exists():
                return requested_abs

        payload_data = payload if isinstance(payload, dict) else {}
        candidate_from_payload = None

        stems = payload_data.get("stems")
        if isinstance(stems, dict):
            candidate_from_payload = stems.get(stem_name)

        if candidate_from_payload is None:
            artifacts = payload_data.get("artifacts")
            if isinstance(artifacts, dict):
                artifact_stems = artifacts.get("stems")
                if isinstance(artifact_stems, dict):
                    candidate_from_payload = artifact_stems.get(stem_name)

        if isinstance(candidate_from_payload, str) and candidate_from_payload.strip():
            candidate_abs = _resolve_candidate(candidate_from_payload)
            if not self._is_path_safe(candidate_abs):
                logger.warning(
                    "Rejected unsafe payload stem path outside workspace: %s",
                    candidate_abs,
                )
                return None
            if Path(candidate_abs).exists():
                return candidate_abs
        return None

if __name__ == "__main__":
    # Quick Test
    logging.basicConfig(level=logging.INFO)
    from dotenv import load_dotenv
    load_dotenv()
    director = MikupDirector()
    # Dummy payload
    print(director.generate_report({"test": "data"}))
