import os
import json
import logging
from google import genai

logger = logging.getLogger(__name__)

PAYLOAD_START_DELIMITER = "BEGIN_MIKUP_PAYLOAD_JSON"
PAYLOAD_END_DELIMITER = "END_MIKUP_PAYLOAD_JSON"

class MikupDirector:
    """
    Stage 5: The AI Director.
    Takes the structured Mikup JSON payload and generates human-readable production notes.
    Using the new google-genai SDK (v1.0.0+).
    """
    def __init__(self):
        api_key = os.getenv("GEMINI_API_KEY")
        if api_key:
            self.client = genai.Client(api_key=api_key)
            # Use gemini-2.0-flash for efficiency or gemini-2.0-pro-exp for maximum depth
            self.model_id = 'gemini-2.0-flash'
        else:
            self.client = None
            logger.warning("GEMINI_API_KEY not found in environment. Stage 5 will be skipped.")

    def load_prompt(self):
        prompt_path = os.path.join(os.path.dirname(__file__), 'director_prompt.md')
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

if __name__ == "__main__":
    # Quick Test
    logging.basicConfig(level=logging.INFO)
    from dotenv import load_dotenv
    load_dotenv()
    director = MikupDirector()
    # Dummy payload
    print(director.generate_report({"test": "data"}))
