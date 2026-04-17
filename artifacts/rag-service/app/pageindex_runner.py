"""Wrap the vendored PageIndex library so the FastAPI app can build a
tree-of-contents from a PDF using AWS Bedrock as the LLM backend.

PageIndex is vectorless: instead of chunking + embedding, it produces a
hierarchical tree (similar to a table of contents) with per-section
summaries. We persist that tree on the document row and use it at query
time for reasoning-based retrieval.
"""
from __future__ import annotations

import os
import tempfile
from typing import Any

from ._pageindex import page_index_main, ConfigLoader
from .config import BEDROCK_CHAT_MODEL_ID

# LiteLLM model string. PageIndex passes this directly to litellm.completion;
# the `bedrock/` prefix tells LiteLLM to route through AWS Bedrock using the
# AWS_* env vars that the workspace already has configured.
LITELLM_MODEL = os.environ.get("PAGEINDEX_LLM_MODEL") or f"bedrock/{BEDROCK_CHAT_MODEL_ID}"


def build_tree_from_pdf(pdf_bytes: bytes) -> list[dict[str, Any]]:
    """Run PageIndex on `pdf_bytes` and return the hierarchical structure.

    The structure is a list of nodes with `title`, `node_id`, `start_index`,
    `end_index`, `summary`, and (recursively) child `nodes`.
    """
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(pdf_bytes)
        tmp_path = tmp.name
    try:
        opt = ConfigLoader().load(
            {
                "model": LITELLM_MODEL,
                # Keep node summaries on (used by retrieval reasoning).
                "if_add_node_summary": "yes",
                "if_add_doc_description": "no",
                "if_add_node_text": "no",
            }
        )
        # PageIndex returns {"doc_name": ..., "structure": [...]} — we only
        # need the structure list for downstream retrieval/reasoning.
        result = page_index_main(tmp_path, opt)
        if isinstance(result, dict):
            structure = result.get("structure", [])
        else:
            structure = result  # defensive: older versions returned the list directly
        if not isinstance(structure, list):
            return []
        return structure
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
