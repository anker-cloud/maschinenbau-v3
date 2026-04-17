"""Page-aware text chunking.

For each page, split the text into overlapping windows of approximately
CHUNK_TARGET_CHARS characters. This keeps citations page-anchored while
keeping each embedded chunk small enough for retrieval to be useful.
"""
from __future__ import annotations

from typing import List, Tuple

from .config import CHUNK_OVERLAP_CHARS, CHUNK_TARGET_CHARS


def chunk_pages(pages: List[Tuple[int, str]]) -> List[dict]:
    """Return [{page_number, chunk_text, metadata}]."""
    out: List[dict] = []
    for page_number, text in pages:
        text = (text or "").strip()
        if not text:
            continue
        if len(text) <= CHUNK_TARGET_CHARS:
            out.append(
                {
                    "page_number": page_number,
                    "chunk_text": text,
                    "metadata": {"page": page_number},
                }
            )
            continue
        start = 0
        idx_in_page = 0
        while start < len(text):
            end = min(start + CHUNK_TARGET_CHARS, len(text))
            # Snap to a sentence boundary if one is nearby.
            if end < len(text):
                window = text[end - 200 : end + 200]
                offsets = [window.rfind(sep) for sep in (". ", "\n", "! ", "? ")]
                best = max(offsets)
                if best > 0:
                    end = end - 200 + best + 1
            chunk_text = text[start:end].strip()
            if chunk_text:
                out.append(
                    {
                        "page_number": page_number,
                        "chunk_text": chunk_text,
                        "metadata": {"page": page_number, "chunk_index": idx_in_page},
                    }
                )
                idx_in_page += 1
            if end >= len(text):
                break
            start = max(end - CHUNK_OVERLAP_CHARS, start + 1)
    return out
