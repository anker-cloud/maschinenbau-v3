"""FastAPI entrypoint for the RAG service.

PageIndex-based, vectorless RAG. The flow is:
- Ingest: download PDF -> let PageIndex build a tree-of-contents using
  AWS Bedrock as the LLM -> persist tree on the document row and per-page
  text in document_chunks.
- Chat: load the trees of (filtered) ready documents -> ask Claude to
  *reason* about which pages to read -> fetch those pages and ask Claude
  to write a grounded answer with citations.
"""
from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from . import db, parsing, storage
from . import bedrock as bedrock_client
from .config import RAG_INTERNAL_SECRET
from .pageindex_runner import build_tree_from_pdf

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("rag")

app = FastAPI(title="Sturtz RAG Service", root_path="/rag")


def _check_secret(x_internal_secret: str | None) -> None:
    if not RAG_INTERNAL_SECRET:
        return
    if x_internal_secret != RAG_INTERNAL_SECRET:
        raise HTTPException(status_code=401, detail="Invalid internal secret")


# ---------- Schemas ----------

class IngestRequest(BaseModel):
    document_id: str
    file_path: str
    file_type: str
    filename: str | None = None


class IngestResponse(BaseModel):
    document_id: str
    status: str
    pages: int
    nodes: int


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


def _count_nodes(tree: list[dict[str, Any]]) -> int:
    n = 0
    for node in tree:
        n += 1
        if node.get("nodes"):
            n += _count_nodes(node["nodes"])
    return n


@app.post("/ingest", response_model=IngestResponse)
def ingest(
    payload: IngestRequest,
    x_internal_secret: str | None = Header(default=None, alias="X-Internal-Secret"),
) -> IngestResponse:
    _check_secret(x_internal_secret)

    log.info("ingest start document_id=%s path=%s", payload.document_id, payload.file_path)
    db.update_document_status(payload.document_id, "ingesting")
    db.update_document_progress(payload.document_id, 0, 0)  # reset before starting
    try:
        # Reingest is idempotent: drop any previous per-page text.
        db.delete_chunks_for_document(payload.document_id)

        data = storage.download_object(payload.file_path)

        # 1) Persist per-page text so we can serve it back during chat.
        #    Write progress after each page so the admin UI shows a real bar.
        pages = parsing.parse_document(data, payload.file_type, payload.filename or "")
        if not pages:
            db.update_document_status(payload.document_id, "failed")
            raise HTTPException(status_code=422, detail="Could not extract text from document")

        total = len(pages)
        # Record total so the frontend can show "0 / N" immediately.
        db.update_document_progress(payload.document_id, 0, total)

        # Insert one page at a time and bump the counter so the admin UI
        # can render a live "X / N pages" progress bar.
        BATCH = 5  # commit every N pages to reduce DB round-trips
        batch_buf: list[tuple[int, str]] = []
        stored = 0
        for page_num, text in pages:
            batch_buf.append((page_num, text))
            if len(batch_buf) >= BATCH:
                db.insert_pages(payload.document_id, batch_buf)
                stored += len(batch_buf)
                batch_buf = []
                db.update_document_progress(payload.document_id, stored, total)
        if batch_buf:
            db.insert_pages(payload.document_id, batch_buf)
            stored += len(batch_buf)
            db.update_document_progress(payload.document_id, stored, total)

        # 2) Build the PageIndex tree (PDF only; for non-PDF docs we use a
        #    flat single-node tree so chat retrieval can still find the file).
        ft = (payload.file_type or "").lower()
        name = (payload.filename or "").lower()
        is_pdf = "pdf" in ft or name.endswith(".pdf")
        if is_pdf:
            tree = build_tree_from_pdf(data)
        else:
            tree = [
                {
                    "title": payload.filename or "Document",
                    "node_id": "root",
                    "start_index": 1,
                    "end_index": len(pages),
                    "summary": "Full document (non-PDF, no PageIndex tree)",
                }
            ]
        db.update_document_tree(payload.document_id, tree)
        db.update_document_status(payload.document_id, "ready")
        log.info(
            "ingest done document_id=%s pages=%d nodes=%d",
            payload.document_id,
            len(pages),
            _count_nodes(tree),
        )
        return IngestResponse(
            document_id=payload.document_id,
            status="ready",
            pages=len(pages),
            nodes=_count_nodes(tree),
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


# ---------- Chat (PageIndex reasoning) ----------

SYSTEM_PROMPT = """You are the Sturtz Maschinenbau technical support assistant.
You help engineers and operators diagnose and resolve issues with Sturtz machinery and parts.

Rules:
- Answer ONLY using the provided document excerpts. If the answer is not present, say so plainly.
- Reference the source by inline markers like [1], [2] that map to the citations list. Do not invent citations.
- Prefer concise, step-by-step technical guidance.
- When safety-relevant (electrical, hydraulic, pneumatic, lockout/tagout), call it out explicitly.
- If multiple manuals could apply, briefly state which one you used and why.
"""

ROUTING_PROMPT = """You are a retrieval planner for a technical support chatbot.
Given the user's question and a list of document tree-of-contents structures,
pick the document IDs and page ranges that are MOST LIKELY to contain the
answer. Prefer specific pages over whole sections; cap your selection to the
most relevant ~8 pages total across all documents.

Respond with ONLY a JSON object of the form:
{"selections": [{"document_id": "<uuid>", "pages": [<int>, <int>, ...]}, ...]}

If nothing looks relevant, respond with {"selections": []}.
"""


def _summarize_tree(tree: list[dict[str, Any]], depth: int = 0, max_depth: int = 3) -> str:
    out: list[str] = []
    for node in tree:
        title = (node.get("title") or "").strip()
        start = node.get("start_index")
        end = node.get("end_index")
        summary = (node.get("summary") or "").strip()
        prefix = "  " * depth + "- "
        page_range = f"pp.{start}-{end}" if start and end else ""
        line = f"{prefix}{title} {page_range}".strip()
        if summary:
            line += f" — {summary[:160]}"
        out.append(line)
        if depth + 1 < max_depth and node.get("nodes"):
            out.append(_summarize_tree(node["nodes"], depth + 1, max_depth))
    return "\n".join(out)


def _extract_json_object(text: str) -> dict[str, Any] | None:
    """Extract a JSON object from an LLM response.

    Tolerates prose wrapping, fenced blocks, and trailing commentary by
    finding the first `{` and walking to its matching `}`.
    """
    if not text:
        return None
    # Prefer ```json ... ``` fenced blocks if present.
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fenced:
        try:
            return json.loads(fenced.group(1))
        except json.JSONDecodeError:
            pass
    # Otherwise walk braces to find a balanced object.
    start = text.find("{")
    while start != -1:
        depth = 0
        in_str = False
        escape = False
        for i in range(start, len(text)):
            ch = text[i]
            if escape:
                escape = False
                continue
            if ch == "\\":
                escape = True
                continue
            if ch == '"':
                in_str = not in_str
                continue
            if in_str:
                continue
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    candidate = text[start : i + 1]
                    try:
                        return json.loads(candidate)
                    except json.JSONDecodeError:
                        break
        start = text.find("{", start + 1)
    return None


def _coerce_pages(raw_pages: Any) -> list[int]:
    """Best-effort coercion of planner page selections.

    Accepts ints, numeric strings, and dash-ranges like "3-5". Anything
    unparseable is silently dropped (per-item) instead of raising.
    """
    out: list[int] = []
    if not isinstance(raw_pages, list):
        return out
    for p in raw_pages:
        if isinstance(p, bool):  # bool is a subclass of int — skip
            continue
        if isinstance(p, int):
            if p > 0:
                out.append(p)
            continue
        if isinstance(p, str):
            s = p.strip()
            if "-" in s:
                parts = s.split("-", 1)
                try:
                    start = int(parts[0].strip())
                    end = int(parts[1].strip())
                    if start > 0 and end >= start and end - start <= 50:
                        out.extend(range(start, end + 1))
                except ValueError:
                    continue
            else:
                m = re.search(r"\d+", s)
                if m:
                    try:
                        n = int(m.group(0))
                        if n > 0:
                            out.append(n)
                    except ValueError:
                        continue
    return out


def _plan_retrieval(
    query: str, docs: list[dict[str, Any]]
) -> list[tuple[str, list[int]]]:
    if not docs:
        return []
    blocks: list[str] = []
    for d in docs:
        tree = d["tree_structure"] or []
        if isinstance(tree, str):
            try:
                tree = json.loads(tree)
            except Exception:
                tree = []
        blocks.append(
            f"document_id: {d['id']}\ntitle: {d['title']}\nstructure:\n{_summarize_tree(tree)}"
        )
    user_msg = (
        f"User question:\n{query}\n\nAvailable documents:\n\n"
        + "\n\n---\n\n".join(blocks)
    )
    try:
        raw = bedrock_client.chat(
            ROUTING_PROMPT, [{"role": "user", "content": user_msg}], max_tokens=600
        )
    except Exception:
        log.exception("planner LLM call failed; falling back to no selection")
        return []

    parsed = _extract_json_object(raw)
    if not isinstance(parsed, dict):
        return []
    out: list[tuple[str, list[int]]] = []
    for sel in parsed.get("selections", []) or []:
        if not isinstance(sel, dict):
            continue
        doc_id = sel.get("document_id")
        if not isinstance(doc_id, str) or not doc_id:
            continue
        pages = _coerce_pages(sel.get("pages"))
        if pages:
            out.append((doc_id, sorted(set(pages))[:8]))
    return out


def _build_answer_context(
    selections: list[tuple[str, list[int]]],
    docs_by_id: dict[str, dict[str, Any]],
) -> tuple[str, list[Citation]]:
    citations: list[Citation] = []
    blocks: list[str] = []
    cite_idx = 0
    for doc_id, pages in selections:
        doc = docs_by_id.get(doc_id)
        if not doc:
            continue
        rows = db.get_pages(doc_id, pages)
        for row in rows:
            cite_idx += 1
            page_num = int(row["page_number"])
            text = (row["chunk_text"] or "").strip()
            snippet = text.replace("\n", " ")
            if len(snippet) > 280:
                snippet = snippet[:280] + "..."
            citations.append(
                Citation(
                    documentId=str(doc_id),
                    documentTitle=doc["title"] or doc.get("filename") or "document",
                    pageNumber=page_num,
                    snippet=snippet,
                )
            )
            blocks.append(
                f"[{cite_idx}] {doc['title']} (page {page_num}):\n{text}"
            )
    return ("\n\n".join(blocks), citations)


@app.post("/chat", response_model=ChatResponse)
def chat(
    payload: ChatRequest,
    x_internal_secret: str | None = Header(default=None, alias="X-Internal-Secret"),
):
    _check_secret(x_internal_secret)

    docs = db.get_ready_documents(payload.document_ids)
    docs_by_id = {str(d["id"]): d for d in docs}

    selections = _plan_retrieval(payload.message, docs) if docs else []
    context, citations = _build_answer_context(selections, docs_by_id)

    user_content = (
        f"Question:\n{payload.message}\n\n"
        f"Document excerpts (cite as [1], [2], ...):\n"
        f"{context if context else '(no excerpts found)'}"
    )
    history_msgs: list[dict[str, Any]] = []
    for m in payload.history[-10:]:
        if m.role in ("user", "assistant") and m.content:
            history_msgs.append({"role": m.role, "content": m.content})
    messages = history_msgs + [{"role": "user", "content": user_content}]

    if payload.stream:
        def event_stream():
            yield 'data: {"type":"start"}\n\n'
            for delta in bedrock_client.chat_stream(SYSTEM_PROMPT, messages):
                yield f"data: {json.dumps({'type':'delta','text':delta})}\n\n"
            yield f"data: {json.dumps({'type':'citations','citations':[c.model_dump() for c in citations]})}\n\n"
            yield 'data: {"type":"done"}\n\n'

        return StreamingResponse(event_stream(), media_type="text/event-stream")

    answer = bedrock_client.chat(SYSTEM_PROMPT, messages)
    return ChatResponse(content=answer, citations=citations)


@app.exception_handler(Exception)
def _on_error(_: Request, exc: Exception):
    log.exception("unhandled error")
    return JSONResponse(status_code=500, content={"error": str(exc)})
