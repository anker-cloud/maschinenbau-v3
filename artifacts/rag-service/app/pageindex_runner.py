"""HTTP client wrapper for the standalone PageIndex service.

build_tree_from_pdf() keeps the same signature as before so main.py
requires zero changes. Internally it POSTs the PDF to the PageIndex
service and GETs the resulting tree structure.
"""
from __future__ import annotations

import logging
import time
from typing import Any

import httpx

from .config import PAGEINDEX_SERVICE_URL

log = logging.getLogger("rag.pageindex_runner")

# Tree building can take many minutes for large PDFs.
# Large documents (400+ pages) can take well over 15 minutes to index.
_TIMEOUT = httpx.Timeout(connect=10.0, read=3600.0, write=60.0, pool=5.0)

_OUTER_BACKOFF = [60, 120]


class _PageIndexRateLimitError(RuntimeError):
    """PageIndex returned 500/503 with Bedrock rate limit exhaustion text."""


def _is_rate_limit_exhaustion(text: str) -> bool:
    lower = text.lower()
    return any(
        p in lower
        for p in ("ratelimiterror", "rate limit", "throttling", "too many requests", "429")
    )


def _build_tree_attempt(pdf_bytes: bytes) -> list[dict[str, Any]]:
    """Single attempt to upload pdf_bytes to PageIndex and return the tree.

    Raises _PageIndexRateLimitError when the service responds with 500/503
    due to Bedrock rate limit exhaustion so the outer retry loop can back off
    and try again. Raises RuntimeError for all other failures.
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

        if upload_resp.status_code in (500, 503):
            if _is_rate_limit_exhaustion(upload_resp.text):
                raise _PageIndexRateLimitError(
                    f"HTTP {upload_resp.status_code} — rate limit exhausted"
                )
            raise RuntimeError(
                f"PageIndex upload failed: HTTP {upload_resp.status_code} — {upload_resp.text[:200]}"
            )
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
        if structure_resp.status_code in (500, 503):
            if _is_rate_limit_exhaustion(structure_resp.text):
                raise _PageIndexRateLimitError(
                    f"HTTP {structure_resp.status_code} — rate limit exhausted"
                )
            raise RuntimeError(
                f"PageIndex structure fetch failed: HTTP {structure_resp.status_code} — {structure_resp.text[:200]}"
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


def build_tree_from_pdf(pdf_bytes: bytes) -> list[dict[str, Any]]:
    """Upload pdf_bytes to the PageIndex service and return the tree structure.

    Retries up to 3 times (with 60 s then 120 s back-off) when PageIndex
    returns HTTP 500/503 due to Bedrock rate limit exhaustion. All other
    failures raise RuntimeError immediately so the ingest worker can mark
    the document as failed (consistent with prior behaviour).

    Returns a list of tree nodes with title, node_id, start_index, end_index,
    summary, and (recursively) child nodes — same shape as before.
    """
    last_exc: Exception | None = None
    for outer_attempt in range(3):
        if outer_attempt > 0:
            wait = _OUTER_BACKOFF[outer_attempt - 1]
            log.warning(
                "pageindex: rate-limit outer retry %d/3, waiting %ds",
                outer_attempt + 1,
                wait,
            )
            time.sleep(wait)
        try:
            return _build_tree_attempt(pdf_bytes)
        except _PageIndexRateLimitError as e:
            last_exc = e
        except RuntimeError:
            raise  # non-rate-limit failure: fail immediately, no outer retry
    raise RuntimeError(
        "PageIndex failed after 3 outer retries due to Bedrock rate limit exhaustion"
    ) from last_exc
