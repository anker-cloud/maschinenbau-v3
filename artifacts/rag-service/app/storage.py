"""Download document bytes from object storage.

`file_path` is the normalized path stored in the documents table, e.g.
`/objects/uploads/<uuid>`. We resolve it back to a GCS object using the
PRIVATE_OBJECT_DIR env var, request a short-lived signed GET URL from the
Replit sidecar (same mechanism the Node API server uses for uploads), then
fetch the bytes from that URL. No GCS SDK or token exchange needed.
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import requests

from .config import PRIVATE_OBJECT_DIR

REPLIT_SIDECAR = "http://127.0.0.1:1106"


def _parse_gcs_path(path: str):
    """Split '/bucket/a/b/c' into ('bucket', 'a/b/c')."""
    path = path.lstrip("/")
    parts = path.split("/", 1)
    if len(parts) < 2:
        raise ValueError(f"Invalid GCS path (need bucket + object): /{path}")
    return parts[0], parts[1]


def _signed_download_url(bucket_name: str, object_name: str, ttl_seconds: int = 900) -> str:
    """Ask the Replit sidecar for a signed GET URL valid for ttl_seconds."""
    expires_at = (datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds)).isoformat()
    resp = requests.post(
        f"{REPLIT_SIDECAR}/object-storage/signed-object-url",
        json={
            "bucket_name": bucket_name,
            "object_name": object_name,
            "method": "GET",
            "expires_at": expires_at,
        },
        timeout=15,
    )
    resp.raise_for_status()
    data = resp.json()
    url = data.get("signed_url")
    if not url:
        raise RuntimeError(f"Sidecar did not return signed_url: {data}")
    return url


def download_object(file_path: str) -> bytes:
    """Resolve `/objects/<entityId>` -> PRIVATE_OBJECT_DIR + entityId, get a
    signed download URL from the sidecar, and return the file bytes."""
    if not file_path.startswith("/objects/"):
        raise ValueError(f"Unexpected file_path: {file_path}")
    entity_id = file_path[len("/objects/"):]

    if not PRIVATE_OBJECT_DIR:
        raise RuntimeError("PRIVATE_OBJECT_DIR is not set")

    full_path = PRIVATE_OBJECT_DIR.rstrip("/") + "/" + entity_id
    bucket_name, object_name = _parse_gcs_path(full_path)

    signed_url = _signed_download_url(bucket_name, object_name)
    resp = requests.get(signed_url, timeout=120, stream=True)
    resp.raise_for_status()
    return resp.content
