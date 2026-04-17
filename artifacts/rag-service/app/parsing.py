"""Document parsing -> per-page text extraction.

Returns a list of (page_number, text) tuples. Page numbers are 1-indexed
so they match the citation hyperlinks (`#page=N`) the frontend renders.
"""
from __future__ import annotations

import io
from typing import List, Tuple

from pypdf import PdfReader
from docx import Document as DocxDocument


def parse_pdf(data: bytes) -> List[Tuple[int, str]]:
    reader = PdfReader(io.BytesIO(data))
    out: List[Tuple[int, str]] = []
    for i, page in enumerate(reader.pages, start=1):
        try:
            text = page.extract_text() or ""
        except Exception:
            text = ""
        out.append((i, text))
    return out


def parse_docx(data: bytes) -> List[Tuple[int, str]]:
    doc = DocxDocument(io.BytesIO(data))
    # docx has no real "pages"; treat each ~3000-char block as a virtual page.
    text = "\n".join(p.text for p in doc.paragraphs if p.text)
    if not text.strip():
        return []
    chunk_size = 3000
    pages: List[Tuple[int, str]] = []
    for i in range(0, len(text), chunk_size):
        pages.append((i // chunk_size + 1, text[i : i + chunk_size]))
    return pages


def parse_txt(data: bytes) -> List[Tuple[int, str]]:
    text = data.decode("utf-8", errors="replace")
    if not text.strip():
        return []
    chunk_size = 3000
    return [
        (i // chunk_size + 1, text[i : i + chunk_size])
        for i in range(0, len(text), chunk_size)
    ]


def parse_document(data: bytes, file_type: str, filename: str = "") -> List[Tuple[int, str]]:
    ft = (file_type or "").lower()
    name = filename.lower()
    if "pdf" in ft or name.endswith(".pdf"):
        return parse_pdf(data)
    if "word" in ft or "docx" in ft or name.endswith(".docx"):
        return parse_docx(data)
    if "text" in ft or name.endswith((".txt", ".md")):
        return parse_txt(data)
    # Fallback: try PDF first, then text.
    try:
        return parse_pdf(data)
    except Exception:
        return parse_txt(data)
