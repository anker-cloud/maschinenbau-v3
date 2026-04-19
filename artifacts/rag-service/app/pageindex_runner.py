"""HTTP client wrapper for the standalone PageIndex service.

build_tree_from_pdf() keeps the same signature as before so main.py
requires zero changes. Internally it POSTs the PDF to the PageIndex
service and GETs the resulting tree structure.
"""
from __future__ import annotations

import logging
from typing import Any

import httpx

from .config import PAGEINDEX_SERVICE_URL

log = logging.getLogger("rag.pageindex_runner")

# Tree building can take many minutes for large PDFs.
_TIMEOUT = httpx.Timeout(connect=10.0, read=900.0, write=60.0, pool=5.0)


def build_tree_from_pdf(pdf_bytes: bytes) -> list[dict[str, Any]]:
    """Upload pdf_bytes to the PageIndex service and return the tree structure.

    Returns a list of tree nodes with title, node_id, start_index, end_index,
    summary, and (recursively) child nodes — same shape as before.

    Raises RuntimeError on any failure so the ingest worker can catch it and
    mark the document as failed (consistent with prior behaviour).
    """
    with httpx.Client(timeout=_TIMEOUT) as client:
        try:
            upload_resp = client.post(
                f"{PAGEINDEX_SERVICE_URL}/documents",
                files={"file": ("document.pdf", pdf_bytes, "application/pdf")},
            )
        except httpx.TimeoutException as exc:
            raise RuntimeError(
                f"PageIndex service timed out during upload: {exc}"
            ) from exc
        except httpx.ConnectError as exc:
            raise RuntimeError(
                f"PageIndex service unreachable at {PAGEINDEX_SERVICE_URL}: {exc}"
            ) from exc

        if upload_resp.status_code != 200:
            raise RuntimeError(
                f"PageIndex upload failed: HTTP {upload_resp.status_code} — {upload_resp.text[:200]}"
            )

        doc_id = upload_resp.json().get("doc_id")
        if not doc_id:
            raise RuntimeError(
                f"PageIndex upload response missing doc_id: {upload_resp.text[:200]}"
            )
        log.info("pageindex: uploaded pdf, doc_id=%s", doc_id)

        try:
            structure_resp = client.get(
                f"{PAGEINDEX_SERVICE_URL}/documents/{doc_id}/structure",
            )
        except httpx.TimeoutException as exc:
            raise RuntimeError(
                f"PageIndex service timed out fetching structure for doc_id={doc_id}: {exc}"
            ) from exc
        except httpx.ConnectError as exc:
            raise RuntimeError(
                f"PageIndex service unreachable fetching structure: {exc}"
            ) from exc

        if structure_resp.status_code == 404:
            raise RuntimeError(
                f"PageIndex structure not found for doc_id={doc_id} "
                "(service may have restarted between upload and fetch)"
            )
        if structure_resp.status_code != 200:
            raise RuntimeError(
                f"PageIndex structure fetch failed: HTTP {structure_resp.status_code} — {structure_resp.text[:200]}"
            )

        structure = structure_resp.json()

        # Defensive unwrap: server returns the list directly, but handle dict wrapper too
        if isinstance(structure, dict):
            structure = structure.get("structure", [])

        if not isinstance(structure, list) or not structure:
            raise RuntimeError(
                f"PageIndex returned an empty or invalid tree for doc_id={doc_id}"
            )

        log.info("pageindex: tree built, doc_id=%s nodes=%d", doc_id, len(structure))
        return structure
