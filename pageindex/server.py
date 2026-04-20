import asyncio
import json
import os
import shutil
import tempfile
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import JSONResponse

from pageindex import PageIndexClient


@asynccontextmanager
async def lifespan(app: FastAPI):
    model = os.environ.get("PAGEINDEX_MODEL", "bedrock/global.anthropic.claude-sonnet-4-6")
    workspace = os.environ.get("PAGEINDEX_WORKSPACE", "/workspace")
    app.state.client = PageIndexClient(workspace=workspace, model=model)
    yield


app = FastAPI(title="PageIndex API", lifespan=lifespan)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/documents")
async def index_document(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported")

    with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = tmp.name

    try:
        # page_index_main uses asyncio.run() internally. Running it directly
        # from an async FastAPI endpoint crashes because asyncio.run() cannot
        # be called from a running event loop. asyncio.to_thread() moves the
        # call to a worker thread that has no running event loop, so
        # asyncio.run() works as intended.
        doc_id = await asyncio.to_thread(app.state.client.index, tmp_path)
    finally:
        os.unlink(tmp_path)

    return {"doc_id": doc_id, "filename": file.filename}


@app.get("/documents/{doc_id}")
def get_document(doc_id: str):
    result = app.state.client.get_document(doc_id)
    if not result:
        raise HTTPException(status_code=404, detail="Document not found")
    return json.loads(result)


@app.get("/documents/{doc_id}/structure")
def get_structure(doc_id: str):
    result = app.state.client.get_document_structure(doc_id)
    if not result:
        raise HTTPException(status_code=404, detail="Document not found")
    return json.loads(result)


@app.get("/documents/{doc_id}/pages")
def get_pages(
    doc_id: str,
    pages: str = Query(..., description="Page range e.g. '5-10' or '3,7,12'")
):
    result = app.state.client.get_page_content(doc_id, pages)
    if not result:
        raise HTTPException(status_code=404, detail="Document not found")
    return json.loads(result)
