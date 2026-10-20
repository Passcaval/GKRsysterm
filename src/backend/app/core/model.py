"""Minimal OpenAI-compatible model gateway used by the admissions crawler.

No SDK dependency: a single ``POST /chat/completions`` with JSON output and
bounded retries. The gateway never logs prompts or the API key.
"""

from __future__ import annotations

import json
import re
import time

import httpx

from app.core.config import Settings


class ModelNotConfigured(Exception):
    pass


class ModelCallFailed(Exception):
    def __init__(self, message: str, *, status: int | None = None):
        super().__init__(message)
        self.status = status


class ModelOutputInvalid(Exception):
    pass


def _content_text(value) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for part in value:
            if isinstance(part, dict) and isinstance(part.get("text"), str):
                parts.append(part["text"])
        return "".join(parts)
    return ""


def _strip_fences(value: str) -> str:
    text = value.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*```$", "", text)
    return text.strip()


class ModelGateway:
    def __init__(self, settings: Settings, *, client: httpx.Client | None = None):
        if not settings.model_configured:
            raise ModelNotConfigured("MODEL_BASE_URL/MODEL_API_KEY/MODEL_NAME are required")
        self.base_url = settings.model_base_url.rstrip("/")
        self.api_key = settings.model_api_key
        self.model = settings.model_name
        self.json_mode = True
        self.timeout_seconds = settings.model_timeout_seconds
        self.max_output_tokens = settings.model_max_output_tokens
        self._client = client or httpx.Client(
            timeout=httpx.Timeout(self.timeout_seconds),
            follow_redirects=False,
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "ModelGateway":
        return self

    def __exit__(self, *_) -> None:
        self.close()

    @property
    def endpoint(self) -> str:
        if self.base_url.endswith("/chat/completions"):
            return self.base_url
        return self.base_url + "/chat/completions"

    def complete_json(
        self,
        system: str,
        user: str,
        *,
        max_tokens: int | None = None,
        temperature: float = 0,
    ) -> tuple[dict, dict]:
        body = {
            "model": self.model,
            "temperature": temperature,
            "max_tokens": max_tokens or self.max_output_tokens,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }
        if self.json_mode:
            body["response_format"] = {"type": "json_object"}

        last_error: Exception | None = None
        for attempt in range(3):
            try:
                response = self._client.post(
                    self.endpoint,
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json",
                    },
                    json=body,
                )
            except (httpx.TimeoutException, httpx.HTTPError) as exc:
                last_error = exc
            else:
                if response.status_code == 400 and self.json_mode:
                    # Some compatible providers do not implement response_format.
                    self.json_mode = False
                    body.pop("response_format", None)
                    last_error = ModelCallFailed(
                        "provider rejected JSON mode", status=response.status_code
                    )
                elif response.status_code == 429 or response.status_code >= 500:
                    last_error = ModelCallFailed(
                        "model provider temporarily unavailable",
                        status=response.status_code,
                    )
                elif response.status_code >= 400:
                    raise ModelCallFailed(
                        f"model provider rejected the request ({response.status_code})",
                        status=response.status_code,
                    )
                else:
                    try:
                        data = response.json()
                        content = _content_text(data["choices"][0]["message"]["content"])
                        parsed = json.loads(_strip_fences(content))
                        if not isinstance(parsed, dict):
                            raise ValueError("top-level JSON must be an object")
                    except (KeyError, IndexError, TypeError, ValueError) as exc:
                        raise ModelOutputInvalid("model did not return a JSON object") from exc
                    usage = data.get("usage") if isinstance(data, dict) else None
                    return parsed, usage if isinstance(usage, dict) else {}
            if attempt < 2:
                time.sleep(0.5 * (2**attempt))
        if isinstance(last_error, ModelCallFailed):
            raise last_error
        raise ModelCallFailed("model call failed") from last_error

    def stream_text(
        self,
        messages: list[dict],
        *,
        max_tokens: int | None = None,
        temperature: float = 0.3,
    ):
        """Yield text deltas from an OpenAI-compatible streaming response.

        The caller owns the iteration; closing the generator closes the
        underlying HTTP response. Reasoning content, if a provider emits it,
        is intentionally ignored; only final ``delta.content`` is surfaced.
        """
        body = {
            "model": self.model,
            "temperature": temperature,
            "max_tokens": max_tokens or self.max_output_tokens,
            "messages": messages,
            "stream": True,
        }
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        }
        try:
            with self._client.stream("POST", self.endpoint, headers=headers, json=body) as response:
                if response.status_code >= 400:
                    response.read()
                    raise ModelCallFailed(
                        f"model provider rejected the request ({response.status_code})",
                        status=response.status_code,
                    )
                for raw_line in response.iter_lines():
                    line = raw_line.strip()
                    if not line or line.startswith(":"):
                        continue
                    if not line.startswith("data:"):
                        continue
                    payload = line[5:].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        data = json.loads(payload)
                        if isinstance(data, dict) and data.get("error"):
                            raise ModelCallFailed("model provider returned an error")
                        delta = data["choices"][0].get("delta") or {}
                        text = delta.get("content")
                    except (json.JSONDecodeError, KeyError, IndexError, TypeError):
                        continue
                    if isinstance(text, str) and text:
                        yield text
        except httpx.HTTPError as exc:
            raise ModelCallFailed("model stream failed") from exc
