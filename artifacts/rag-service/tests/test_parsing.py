"""Unit tests for artifacts/rag-service/app/parsing.py.

All functions under test are pure (bytes-in, list-out), so no mocking is needed.
"""
from __future__ import annotations

import io

import pytest

from app.parsing import parse_docx, parse_document, parse_pdf, parse_txt


# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_docx_bytes(*paragraphs: str) -> bytes:
    """Return DOCX bytes containing the given paragraphs."""
    from docx import Document as DocxDocument
    doc = DocxDocument()
    for p in paragraphs:
        doc.add_paragraph(p)
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def _make_pdf_bytes(pages: list[str]) -> bytes:
    """Return PDF bytes with one text label per page (requires reportlab)."""
    from reportlab.pdfgen import canvas
    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    for text in pages:
        c.drawString(72, 700, text)
        c.showPage()
    c.save()
    return buf.getvalue()


# ── parse_txt ─────────────────────────────────────────────────────────────────

class TestParseTxt:
    def test_empty_bytes_returns_empty(self):
        assert parse_txt(b"") == []

    def test_whitespace_only_returns_empty(self):
        assert parse_txt(b"   \n\t  ") == []

    def test_short_text_produces_single_page(self):
        pages = parse_txt(b"Hello, world!")
        assert pages == [(1, "Hello, world!")]

    def test_pages_are_one_indexed(self):
        pages = parse_txt(b"x")
        assert pages[0][0] == 1

    def test_text_longer_than_chunk_splits_into_multiple_pages(self):
        text = "A" * 7001
        pages = parse_txt(text.encode())
        assert len(pages) == 3
        assert [p[0] for p in pages] == [1, 2, 3]

    def test_full_chunks_are_exactly_3000_chars(self):
        text = "B" * 6001
        pages = parse_txt(text.encode())
        assert len(pages[0][1]) == 3000
        assert len(pages[1][1]) == 3000
        assert len(pages[2][1]) == 1

    def test_utf8_decoding(self):
        pages = parse_txt("Ünïcödé".encode("utf-8"))
        assert "Ünïcödé" in pages[0][1]

    def test_replacement_character_on_invalid_utf8(self):
        # b"\xff\xfe" is not valid UTF-8; should decode with replacement.
        pages = parse_txt(b"\xff\xfe")
        assert len(pages) == 1
        assert "\ufffd" in pages[0][1]


# ── parse_docx ────────────────────────────────────────────────────────────────

class TestParseDocx:
    def test_empty_document_returns_empty(self):
        data = _make_docx_bytes()
        assert parse_docx(data) == []

    def test_short_document_produces_single_page(self):
        data = _make_docx_bytes("Hello docx")
        pages = parse_docx(data)
        assert len(pages) == 1
        assert pages[0][0] == 1
        assert "Hello docx" in pages[0][1]

    def test_pages_are_one_indexed(self):
        data = _make_docx_bytes("content")
        pages = parse_docx(data)
        assert pages[0][0] == 1

    def test_multiple_paragraphs_joined_in_text(self):
        data = _make_docx_bytes("First", "Second", "Third")
        pages = parse_docx(data)
        combined = "\n".join(p[1] for p in pages)
        assert "First" in combined
        assert "Second" in combined
        assert "Third" in combined

    def test_large_document_splits_into_pages(self):
        long_para = "W" * 3001
        data = _make_docx_bytes(long_para)
        pages = parse_docx(data)
        assert len(pages) >= 2


# ── parse_pdf ─────────────────────────────────────────────────────────────────

reportlab_missing = pytest.importorskip("reportlab", reason="reportlab not installed")


class TestParsePdf:
    def test_single_page_pdf(self):
        data = _make_pdf_bytes(["Page one text"])
        pages = parse_pdf(data)
        assert len(pages) == 1
        assert pages[0][0] == 1

    def test_multi_page_pdf_preserves_order(self):
        data = _make_pdf_bytes(["First", "Second", "Third"])
        pages = parse_pdf(data)
        assert len(pages) == 3
        assert [p[0] for p in pages] == [1, 2, 3]

    def test_returns_list_of_tuples(self):
        data = _make_pdf_bytes(["content"])
        pages = parse_pdf(data)
        assert all(isinstance(p, tuple) and len(p) == 2 for p in pages)


# ── parse_document routing ───────────────────────────────────────────────────

class TestParseDocumentRouting:
    def test_routes_txt_by_mime(self):
        pages = parse_document(b"plain text", "text/plain")
        assert pages == [(1, "plain text")]

    def test_routes_txt_by_md_filename(self):
        pages = parse_document(b"markdown", "", "readme.md")
        assert pages == [(1, "markdown")]

    def test_routes_txt_by_txt_filename(self):
        pages = parse_document(b"notes", "", "notes.txt")
        assert pages == [(1, "notes")]

    def test_routes_docx_by_mime(self):
        data = _make_docx_bytes("docx content")
        pages = parse_document(data, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        assert len(pages) >= 1

    def test_routes_docx_by_filename(self):
        data = _make_docx_bytes("docx file")
        pages = parse_document(data, "application/octet-stream", "report.docx")
        assert len(pages) >= 1

    def test_unknown_type_falls_back_to_text(self):
        pages = parse_document(b"readable text", "application/unknown")
        assert pages == [(1, "readable text")]

    def test_empty_txt_content_returns_empty(self):
        pages = parse_document(b"", "text/plain")
        assert pages == []
