"""Grok (xAI) LLM client — OpenAI-compatible API at api.x.ai/v1."""

import os

from langchain_openai import ChatOpenAI


def get_llm(model: str | None = None, temperature: float = 0.0) -> ChatOpenAI:
    # "placeholder" lets the client object construct without a key present;
    # actual API calls will fail with an auth error until GROK_API_KEY is set.
    key = os.getenv("GROK_API_KEY") or "placeholder"
    return ChatOpenAI(
        model=model or os.getenv("LLM_MODEL", "grok-3"),
        api_key=key,
        base_url="https://api.x.ai/v1",
        temperature=temperature,
    )
