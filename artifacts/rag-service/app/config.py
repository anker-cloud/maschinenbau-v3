"""Runtime configuration for the RAG service.

All values come from environment variables. Defaults match the dev setup so
local runs do not need extra wiring.
"""
from __future__ import annotations

import os


def _required(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return val


DATABASE_URL = os.environ.get("DATABASE_URL", "")

AWS_REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"

# Bedrock model IDs. Override via env if a different region/model is enabled.
BEDROCK_CHAT_MODEL_ID = os.environ.get(
    "BEDROCK_CHAT_MODEL_ID", "global.anthropic.claude-sonnet-4-5-20250929-v1:0"
)
BEDROCK_EMBEDDING_MODEL_ID = os.environ.get(
    "BEDROCK_EMBEDDING_MODEL_ID", "amazon.titan-embed-text-v2:0"
)

# When the RAG service needs to download a private object, it asks the API
# server which knows how to authenticate against object storage. We send a
# service-to-service shared secret so the API can authorize the call without a
# user JWT.
API_SERVER_BASE_URL = os.environ.get("API_SERVER_BASE_URL", "http://127.0.0.1:8080/api")

# Service-to-service shared secret. Required in production; if missing the
# service will refuse to start. In dev, leaving it unset is allowed and
# disables the header check entirely so local debugging remains friction-free.
RAG_INTERNAL_SECRET = os.environ.get("RAG_INTERNAL_SECRET", "")
if os.environ.get("NODE_ENV") == "production" and not RAG_INTERNAL_SECRET:
    raise RuntimeError(
        "RAG_INTERNAL_SECRET must be set in production to authenticate API server requests"
    )

# Object storage direct access (bypasses the API server entirely).
PRIVATE_OBJECT_DIR = os.environ.get("PRIVATE_OBJECT_DIR", "")
S3_BUCKET = os.environ.get("S3_BUCKET", "")

# Chunking
CHUNK_TARGET_CHARS = int(os.environ.get("CHUNK_TARGET_CHARS", "1500"))
CHUNK_OVERLAP_CHARS = int(os.environ.get("CHUNK_OVERLAP_CHARS", "200"))
RETRIEVAL_TOP_K = int(os.environ.get("RETRIEVAL_TOP_K", "6"))
