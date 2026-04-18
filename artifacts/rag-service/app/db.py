"""Lightweight DB helpers used by the RAG service.

The RAG service shares the Postgres database with the Node API server. We
write to `documents` (status, tree_structure) and `document_chunks` (one row
per page = full page text), and we read both back at query time.

PageIndex is *vectorless* — we no longer populate `document_chunks.embedding`.
The column remains nullable for backward compatibility.
"""
from __future__ import annotations

import json
from contextlib import contextmanager
from typing import Any, Iterable

import psycopg
from psycopg.rows import dict_row

from .config import DATABASE_URL


def _connect() -> psycopg.Connection:
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is not set")
    return psycopg.connect(DATABASE_URL, row_factory=dict_row, autocommit=False)


@contextmanager
def get_conn():
    conn = _connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def update_document_status(document_id: str, status: str) -> None:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE documents SET status = %s WHERE id = %s",
            (status, document_id),
        )


def reset_stuck_ingesting_documents() -> list[str]:
    """Mark any documents left in 'ingesting' status as 'failed'.

    Called at service startup so documents interrupted by a crash or restart
    don't stay stuck in a processing state forever.
    Returns the list of document IDs that were reset.
    """
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE documents SET status = 'failed' WHERE status = 'ingesting' RETURNING id"
        )
        rows = cur.fetchall()
    return [r["id"] for r in rows]


def update_document_progress(
    document_id: str, progress: int, total_pages: int
) -> None:
    """Write page-level ingest progress so the admin UI can show a real progress bar."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE documents SET ingest_progress = %s, ingest_total_pages = %s WHERE id = %s",
            (progress, total_pages, document_id),
        )


def update_document_tree(document_id: str, tree: list[dict[str, Any]]) -> None:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE documents SET tree_structure = %s WHERE id = %s",
            (json.dumps(tree), document_id),
        )


def insert_pages(document_id: str, pages: list[tuple[int, str]]) -> int:
    """Store one row per page (page_number, full page text) — no embeddings."""
    if not pages:
        return 0
    with get_conn() as conn, conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO document_chunks (document_id, page_number, chunk_text, metadata)
            VALUES (%s, %s, %s, %s)
            """,
            [
                (document_id, page_num, text, json.dumps({"page": page_num}))
                for page_num, text in pages
            ],
        )
        return len(pages)


def get_ready_documents(
    document_ids: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Return documents that have a tree_structure populated."""
    where = "WHERE status = 'ready' AND tree_structure IS NOT NULL"
    params: list[Any] = []
    if document_ids:
        where += " AND id = ANY(%s)"
        params.append(document_ids)
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            f"SELECT id, title, filename, tree_structure FROM documents {where}",
            params,
        )
        return list(cur.fetchall())


def get_pages(document_id: str, page_numbers: list[int]) -> list[dict[str, Any]]:
    if not page_numbers:
        return []
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT page_number, chunk_text
            FROM document_chunks
            WHERE document_id = %s AND page_number = ANY(%s)
            ORDER BY page_number
            """,
            (document_id, page_numbers),
        )
        return list(cur.fetchall())


def delete_chunks_for_document(document_id: str) -> int:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "DELETE FROM document_chunks WHERE document_id = %s",
            (document_id,),
        )
        return cur.rowcount


def get_document(document_id: str) -> dict[str, Any] | None:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT * FROM documents WHERE id = %s", (document_id,))
        return cur.fetchone()
