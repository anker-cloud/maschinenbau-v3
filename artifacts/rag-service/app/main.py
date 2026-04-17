"""FastAPI entrypoint for the RAG service.

Mounted at /rag by the workspace router. The Node API server forwards
document ingestion and chat requests here. Authentication / authorization
is handled by the Node side; this service trusts its caller and exposes a
shared `RAG_INTERNAL_SECRET` header check on mutating endpoints.
"""
from __future__ import annotations

import logging
import os
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from . import bedrock, db, parsing, chunking, storage
from .config import RAG_INTERNAL_SECRET, RETRIEVAL_TOP_K

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("rag")

app = FastAPI(title="Sturtz RAG Service", root_path="/rag")


def _check_secret(x_internal_secret: str | None) -> None:
    # If no secret is configured (dev), skip the check entirely.
    if not RAG_INTERNAL_SECRET:
        return
    if x_internal_secret != RAG_INTERNAL_SECRET:
        raise HTTPException(status_code=401, detail="Invalid internal secret")


# ---------- Schemas ----------

class IngestRequest(BaseModel):
    document_id: str
    file_path: str  # /objects/<entityId>
    file_type: str
    filename: str | None = None


class IngestResponse(BaseModel):
    document_id: str
    status: str
    chunks: int
    pages: int


class Citation(BaseModel):
    documentId: str
    documentTitle: str
    pageNumber: int
    snippet: str


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    message: str
    history: list[ChatMessage] = Field(default_factory=list)
    document_ids: list[str] | None = None
    stream: bool = False


class ChatResponse(BaseModel):
    content: str
    citations: list[Citation]


# ---------- Routes ----------

@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/ingest", response_model=IngestResponse)
def ingest(
    payload: IngestRequest,
    x_internal_secret: str | None = Header(default=None, alias="X-Internal-Secret"),
) -> IngestResponse:
    _check_secret(x_internal_secret)

    log.info("ingest start document_id=%s path=%s", payload.document_id, payload.file_path)
    db.update_document_status(payload.document_id, "ingesting")
    try:
        # Drop any previous chunks (idempotent reingest).
        db.delete_chunks_for_document(payload.document_id)

        data = storage.download_object(payload.file_path)
        pages = parsing.parse_document(data, payload.file_type, payload.filename or "")
        if not pages:
            db.update_document_status(payload.document_id, "failed")
            raise HTTPException(status_code=422, detail="Could not extract text from document")

        chunks = chunking.chunk_pages(pages)
        if not chunks:
            db.update_document_status(payload.document_id, "failed")
            raise HTTPException(status_code=422, detail="Document had no chunkable text")

        # Embed and persist.
        for c in chunks:
            c["embedding"] = bedrock.embed_text(c["chunk_text"])
        inserted = db.insert_chunks(payload.document_id, chunks)
        db.update_document_status(payload.document_id, "ready")
        log.info(
            "ingest done document_id=%s pages=%d chunks=%d",
            payload.document_id,
            len(pages),
            inserted,
        )
        return IngestResponse(
            document_id=payload.document_id,
            status="ready",
            chunks=inserted,
            pages=len(pages),
        )
    except HTTPException:
        raise
    except Exception as e:
        log.exception("ingest failed document_id=%s", payload.document_id)
        db.update_document_status(payload.document_id, "failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/documents/{document_id}")
def delete_document(
    document_id: str,
    x_internal_secret: str | None = Header(default=None, alias="X-Internal-Secret"),
) -> dict[str, Any]:
    _check_secret(x_internal_secret)
    deleted = db.delete_chunks_for_document(document_id)
    return {"document_id": document_id, "deleted_chunks": deleted}


SYSTEM_PROMPT = """You are the Sturtz Maschinenbau technical support assistant.
You help engineers and operators diagnose and resolve issues with Sturtz machinery and parts.

Rules:
- Answer ONLY using the provided document excerpts. If the answer is not present, say so plainly.
- Reference the source by inline markers like [1], [2] that map to the citations list. Do not invent citations.
- Prefer concise, step-by-step technical guidance.
- When safety-relevant (electrical, hydraulic, pneumatic, lockout/tagout), call it out explicitly.
- If multiple manuals could apply, briefly state which one you used and why.
"""


def _build_context(hits: list[dict]) -> tuple[str, list[Citation]]:
    citations: list[Citation] = []
    blocks: list[str] = []
    for i, h in enumerate(hits, start=1):
        snippet = (h["chunk_text"] or "").strip().replace("\n", " ")
        if len(snippet) > 280:
            snippet = snippet[:280] + "..."
        citations.append(
            Citation(
                documentId=str(h["document_id"]),
                documentTitle=h["document_title"] or h["document_filename"] or "document",
                pageNumber=int(h["page_number"]),
                snippet=snippet,
            )
        )
        blocks.append(
            f"[{i}] {h['document_title']} (page {h['page_number']}):\n{h['chunk_text']}"
        )
    return ("\n\n".join(blocks), citations)


@app.post("/chat", response_model=ChatResponse)
def chat(
    payload: ChatRequest,
    x_internal_secret: str | None = Header(default=None, alias="X-Internal-Secret"),
):
    _check_secret(x_internal_secret)

    query_embedding = bedrock.embed_text(payload.message)
    hits = db.similarity_search(
        embedding=query_embedding,
        top_k=RETRIEVAL_TOP_K,
        document_ids=payload.document_ids,
    )
    context, citations = _build_context(hits)

    user_content = (
        f"Question:\n{payload.message}\n\n"
        f"Document excerpts (cite as [1], [2], ...):\n{context if context else '(no excerpts found)'}"
    )
    history_msgs: list[dict[str, Any]] = []
    for m in payload.history[-10:]:
        if m.role in ("user", "assistant") and m.content:
            history_msgs.append({"role": m.role, "content": m.content})
    messages = history_msgs + [{"role": "user", "content": user_content}]

    if payload.stream:
        def event_stream():
            yield 'data: {"type":"start"}\n\n'
            for delta in bedrock.chat_stream(SYSTEM_PROMPT, messages):
                import json as _json
                yield f"data: {_json.dumps({'type':'delta','text':delta})}\n\n"
            import json as _json
            yield f"data: {_json.dumps({'type':'citations','citations':[c.model_dump() for c in citations]})}\n\n"
            yield 'data: {"type":"done"}\n\n'

        return StreamingResponse(event_stream(), media_type="text/event-stream")

    answer = bedrock.chat(SYSTEM_PROMPT, messages)
    return ChatResponse(content=answer, citations=citations)


@app.exception_handler(Exception)
def _on_error(_: Request, exc: Exception):
    log.exception("unhandled error")
    return JSONResponse(status_code=500, content={"error": str(exc)})
