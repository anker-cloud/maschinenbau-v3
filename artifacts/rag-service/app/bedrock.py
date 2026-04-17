"""AWS Bedrock client wrappers.

- Embeddings: Amazon Titan Text Embeddings v2 (1024-dim, matches the
  pgvector column in `document_chunks.embedding`).
- Chat: Anthropic Claude 3.5 Sonnet via Bedrock (messages API).
"""
from __future__ import annotations

import json
from typing import Any, Iterator

import boto3

from .config import (
    AWS_REGION,
    BEDROCK_CHAT_MODEL_ID,
    BEDROCK_EMBEDDING_MODEL_ID,
)


def _client():
    return boto3.client("bedrock-runtime", region_name=AWS_REGION)


def embed_text(text: str) -> list[float]:
    """Return a single embedding vector for `text` using Titan v2."""
    body = json.dumps({"inputText": text, "dimensions": 1024, "normalize": True})
    resp = _client().invoke_model(
        modelId=BEDROCK_EMBEDDING_MODEL_ID,
        body=body,
        contentType="application/json",
        accept="application/json",
    )
    payload = json.loads(resp["body"].read())
    return payload["embedding"]


def embed_texts(texts: list[str]) -> list[list[float]]:
    """Embed a batch sequentially. Titan v2 doesn't support batching, but
    this keeps the call site clean and lets us swap implementations later."""
    return [embed_text(t) for t in texts]


def chat(
    system: str,
    messages: list[dict[str, Any]],
    max_tokens: int = 1024,
    temperature: float = 0.2,
) -> str:
    """Non-streaming Claude chat. `messages` is the Anthropic schema:
    [{"role": "user"|"assistant", "content": "..."}]."""
    body = json.dumps(
        {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": max_tokens,
            "temperature": temperature,
            "system": system,
            "messages": messages,
        }
    )
    resp = _client().invoke_model(
        modelId=BEDROCK_CHAT_MODEL_ID,
        body=body,
        contentType="application/json",
        accept="application/json",
    )
    payload = json.loads(resp["body"].read())
    parts = payload.get("content", [])
    return "".join(p.get("text", "") for p in parts if p.get("type") == "text")


def chat_stream(
    system: str,
    messages: list[dict[str, Any]],
    max_tokens: int = 1024,
    temperature: float = 0.2,
) -> Iterator[str]:
    """Yield text deltas from Claude as they arrive."""
    body = json.dumps(
        {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": max_tokens,
            "temperature": temperature,
            "system": system,
            "messages": messages,
        }
    )
    resp = _client().invoke_model_with_response_stream(
        modelId=BEDROCK_CHAT_MODEL_ID,
        body=body,
        contentType="application/json",
        accept="application/json",
    )
    for event in resp.get("body", []):
        chunk = event.get("chunk")
        if not chunk:
            continue
        data = json.loads(chunk.get("bytes", b"{}"))
        if data.get("type") == "content_block_delta":
            delta = data.get("delta", {})
            if delta.get("type") == "text_delta":
                yield delta.get("text", "")
