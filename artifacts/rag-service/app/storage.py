"""Download document bytes from object storage.

`file_path` is the normalized path stored in the documents table, e.g.
`/objects/uploads/<uuid>`. We resolve it back to a GCS object using the
PRIVATE_OBJECT_DIR env var (same convention as the Node API server) and
stream the bytes directly from the bucket using the Replit sidecar token
exchange that the api-server already uses.
"""
from __future__ import annotations

import io
import os
from typing import Tuple

import google.auth
from google.auth.transport.requests import Request as GoogleRequest
from google.cloud import storage
from google.oauth2.credentials import Credentials

from .config import PRIVATE_OBJECT_DIR

REPLIT_SIDECAR_TOKEN_URL = "http://127.0.0.1:1106/token"


def _parse_object_path(path: str) -> Tuple[str, str]:
    if not path.startswith("/"):
        path = "/" + path
    parts = path.split("/")
    if len(parts) < 3:
        raise ValueError(f"Invalid object path: {path}")
    return parts[1], "/".join(parts[2:])


def _client() -> storage.Client:
    # Use the sidecar to mint a short-lived access token, mirroring the
    # external_account flow used by the Node service.
    import requests

    resp = requests.get("http://127.0.0.1:1106/credential", timeout=5)
    resp.raise_for_status()
    payload = resp.json()
    access_token = payload.get("access_token")
    if not access_token:
        raise RuntimeError("Sidecar did not return access_token")
    creds = Credentials(token=access_token)
    return storage.Client(credentials=creds, project="")


def download_object(file_path: str) -> bytes:
    """Resolve `/objects/<entityId>` -> PRIVATE_OBJECT_DIR + entityId, then
    fetch the object bytes."""
    if not file_path.startswith("/objects/"):
        raise ValueError(f"Unexpected file_path: {file_path}")
    entity_id = file_path[len("/objects/"):]
    if not PRIVATE_OBJECT_DIR:
        raise RuntimeError("PRIVATE_OBJECT_DIR is not set")
    full = PRIVATE_OBJECT_DIR.rstrip("/") + "/" + entity_id
    bucket_name, object_name = _parse_object_path(full)
    bucket = _client().bucket(bucket_name)
    blob = bucket.blob(object_name)
    buf = io.BytesIO()
    blob.download_to_file(buf)
    return buf.getvalue()
