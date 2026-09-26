"""Google Gemini LLM provider.

Uses Google's official OpenAI-compatible endpoint at
https://generativelanguage.googleapis.com/v1beta/openai/ with full support for
streaming, tool/function calling, and multimodal vision (images, receipts, invoices).
"""
from __future__ import annotations

import os
from typing import Optional

from app.agents.providers.openai import OpenAIProvider

GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
GEMINI_DEFAULT_MODEL = "gemini-2.5-flash"


class GeminiProvider(OpenAIProvider):
    name = "gemini"

    def __init__(
        self,
        *,
        api_key: str = "",
        base_url: Optional[str] = None,
        model: Optional[str] = None,
    ):
        resolved_key = api_key or os.getenv("AGENTS_GEMINI_API_KEY") or os.getenv("GEMINI_API_KEY") or ""
        resolved_url = base_url or GEMINI_DEFAULT_BASE_URL
        resolved_model = model or GEMINI_DEFAULT_MODEL

        # Strip any prefix like 'models/' if user provided it
        if resolved_model.startswith("models/"):
            resolved_model = resolved_model[len("models/"):]

        super().__init__(
            api_key=resolved_key,
            base_url=resolved_url,
            model=resolved_model,
        )
