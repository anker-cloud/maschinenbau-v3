"""Download document bytes from object storage.

`file_path` is the normalized path stored in the documents table, e.g.
`/objects/uploads/<uuid>`. We resolve it back to a GCS object using the
PRIVATE_OBJECT_DIR env var (same convention as the Node API server) and
download the bytes directly via the GCS JSON REST API using the short-lived
access token from the Replit sidecar — no SDK refresh flow needed.
"""
from __future__ import annotations

import os
from urllib.parse import quote

import requests

from .config import PRIVATE_OBJECT_DIR


def _sidecar_token() -> str:
    """Fetch a fresh access token from the Replit object-storage sidecar."""
    resp = requests.get("http://127.0.0.1:1106/credential", timeout=5)
    resp.raise_for_status()
    payload = resp.json()
    token = payload.get("access_token")
    if not token:
        raise RuntimeError("Sidecar did not return access_token")
    return token


def _parse_gcs_path(path: str):
    """Split '/bucket/a/b/c' into ('bucket', 'a/b/c')."""
    if not path.startswith("/"):
        path = "/" + path
    parts = path.lstrip("/").split("/", 1)
    if len(parts) < 2:
        raise ValueError(f"Invalid GCS path (need bucket + object): {path}")
    return parts[0], parts[1]


def download_object(file_path: str) -> bytes:
    """Resolve `/objects/<entityId>` -> PRIVATE_OBJECT_DIR + entityId, then
    download the object bytes via the GCS JSON REST API."""
    if not file_path.startswith("/objects/"):
        raise ValueError(f"Unexpected file_path: {file_path}")
    entity_id = file_path[len("/objects/"):]

    if not PRIVATE_OBJECT_DIR:
        raise RuntimeError("PRIVATE_OBJECT_DIR is not set")

    full_path = PRIVATE_OBJECT_DIR.rstrip("/") + "/" + entity_id
    bucket_name, object_name = _parse_gcs_path(full_path)

    # GCS JSON download API: GET .../b/{bucket}/o/{object}?alt=media
    encoded_object = quote(object_name, safe="")
    url = (
        f"https://storage.googleapis.com/download/storage/v1/b/"
        f"{bucket_name}/o/{encoded_object}?alt=media"
    )

    access_token = _sidecar_token()
    resp = requests.get(
        url,
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=120,
        stream=True,
    )
    resp.raise_for_status()
    return resp.content
