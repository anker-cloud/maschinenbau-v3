"""Lightweight async-friendly DB helpers using psycopg3.

The RAG service shares the Postgres database with the Node API server. We
write to `documents` (status updates) and `document_chunks` (chunk text +
embedding vector) and read `document_chunks` for similarity search.
"""
from __future__ import annotations

import json
from contextlib import contextmanager
from typing import Any, Iterable

import psycopg
from psycopg.rows import dict_row
from pgvector.psycopg import register_vector

from .config import DATABASE_URL


def _connect() -> psycopg.Connection:
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is not set")
    conn = psycopg.connect(DATABASE_URL, row_factory=dict_row, autocommit=False)
    register_vector(conn)
    return conn


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


def delete_chunks_for_document(document_id: str) -> int:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "DELETE FROM document_chunks WHERE document_id = %s",
            (document_id,),
        )
        return cur.rowcount


def insert_chunks(
    document_id: str,
    chunks: Iterable[dict[str, Any]],
) -> int:
    """Insert a batch of chunks. Each chunk: {page_number, chunk_text, embedding, metadata}.

    `embedding` must be a list[float] of the configured embedding dimension.
    """
    rows = list(chunks)
    if not rows:
        return 0
    with get_conn() as conn, conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO document_chunks (document_id, page_number, chunk_text, embedding, metadata)
            VALUES (%s, %s, %s, %s::vector, %s)
            """,
            [
                (
                    document_id,
                    r["page_number"],
                    r["chunk_text"],
                    r["embedding"],
                    json.dumps(r.get("metadata") or {}),
                )
                for r in rows
            ],
        )
        return len(rows)


def similarity_search(
    embedding: list[float],
    top_k: int,
    document_ids: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Return the top_k most similar chunks (cosine distance) joined with
    their parent document title and filename."""
    where = ""
    params: list[Any] = [embedding]
    if document_ids:
        where = "WHERE c.document_id = ANY(%s)"
        params.append(document_ids)
    params.extend([embedding, top_k])
    sql = f"""
        SELECT c.id, c.document_id, c.page_number, c.chunk_text,
               d.title AS document_title, d.filename AS document_filename,
               1 - (c.embedding <=> %s::vector) AS similarity
        FROM document_chunks c
        JOIN documents d ON d.id = c.document_id
        {where}
        ORDER BY c.embedding <=> %s::vector
        LIMIT %s
    """
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        return list(cur.fetchall())


def get_document(document_id: str) -> dict[str, Any] | None:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT * FROM documents WHERE id = %s", (document_id,))
        return cur.fetchone()
