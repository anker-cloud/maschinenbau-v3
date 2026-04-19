# Migration Checklist: Two-Service Architecture + AWS S3

## Overview

Migrating from a Replit single-service monolith to a clean two-service Docker architecture:
- **PageIndex service** (standalone FastAPI, builds document trees via LLM)
- **Main app** (api-server + rag-service + frontend, calls PageIndex over HTTP)
- **AWS S3** replacing the Replit GCS sidecar for all file storage

---

## Unit 1 — PageIndex HTTP Client

> Replace the in-process vendored PageIndex call with HTTP calls to the standalone PageIndex service.
> `main.py` requires **zero changes** — only `pageindex_runner.py` changes.

- [x] `artifacts/rag-service/app/config.py` — add `PAGEINDEX_SERVICE_URL = os.environ.get("PAGEINDEX_SERVICE_URL", "http://pageindex:8000")`
- [x] `artifacts/rag-service/app/pageindex_runner.py` — full rewrite:
  - [x] Remove all imports of `._pageindex`, `litellm`, `LITELLM_MODEL`
  - [x] Import `httpx` and `PAGEINDEX_SERVICE_URL` from config
  - [x] `POST {PAGEINDEX_SERVICE_URL}/documents` with multipart PDF bytes → get `doc_id`
  - [x] `GET {PAGEINDEX_SERVICE_URL}/documents/{doc_id}/structure` → get tree list
  - [x] Timeout: `httpx.Timeout(connect=10, read=900, write=60, pool=5)` (15 min for large PDFs)
  - [x] Error handling: TimeoutException, ConnectError, non-2xx, empty list → all raise `RuntimeError`
  - [x] Function signature `build_tree_from_pdf(pdf_bytes: bytes) -> list[dict]` stays identical

**Status:** `[x] Complete` — PR: anker-cloud/maschinenbau-v3#1

---

## Unit 2 — Remove Vendored Library + Dependency Cleanup

> Delete the vendored `_pageindex` directory and remove unused deps from `pyproject.toml`.

- [x] Delete `artifacts/rag-service/app/_pageindex/` (all files: `__init__.py`, `page_index.py`, `page_index_md.py`, `retrieve.py`, `utils.py`, `client.py`, `config.yaml`, `__pycache__/`)
- [x] `pyproject.toml` — remove `pageindex>=0.2.8`
- [x] `pyproject.toml` — remove `litellm>=1.83.0`
- [x] Verify no other file in `artifacts/rag-service/app/` imports from `_pageindex`

**Status:** `[x] Complete` — PR: anker-cloud/maschinenbau-v3#2

---

## Unit 3 — rag-service Dockerfile

> Containerize the Python rag-service. Build context = monorepo root (pyproject.toml lives there).

- [x] `artifacts/rag-service/Dockerfile` — create new:
  - [x] Base: `python:3.12-slim`
  - [x] Install `uv` via pip
  - [x] Copy `pyproject.toml` and install deps with `uv pip install --system`
  - [x] Copy `artifacts/rag-service/app/` into image
  - [x] CMD: `uvicorn app.main:app --host 0.0.0.0 --port 8000`
- [x] `artifacts/rag-service/.dockerignore` — exclude `node_modules/`, `.git/`, `__pycache__/`, `_pageindex/`

**Status:** `[x] Complete` — PR: anker-cloud/maschinenbau-v3#3

---

## Unit 4 — api-server Dockerfile

> Containerize the Node.js api-server using a two-stage build (build → runtime).

- [x] `artifacts/api-server/Dockerfile` — create new:
  - [x] Stage 1 (builder): `node:24-slim`, install pnpm, copy workspace files, `pnpm install`, `pnpm build`
  - [x] Stage 2 (runtime): copy built `dist/` and `node_modules/` from builder
  - [x] CMD: `node dist/index.js`
- [x] `artifacts/api-server/.dockerignore` — exclude `node_modules/`, `.git/`, `artifacts/chat-web/`, `artifacts/rag-service/`, `artifacts/mockup-sandbox/`

**Status:** `[x] Complete` — PR: anker-cloud/maschinenbau-v3#4

---

## Unit 5 — Root docker-compose.yml + .env.example

> Orchestrate all services: postgres, pageindex, rag-service, api-server.

- [x] `docker-compose.yml` (repo root) — create new:
  - [x] `postgres` service: `pgvector/pgvector:pg16`, healthcheck, named volume
  - [x] `pageindex` service: build from `./pageindex`, port `8002:8000`, healthcheck, AWS env vars, workspace volume
  - [x] `rag-service` service: build from root with `artifacts/rag-service/Dockerfile`, env vars (DATABASE_URL, PAGEINDEX_SERVICE_URL, S3_BUCKET, AWS_*, BEDROCK_*), depends on postgres+pageindex
  - [x] `api-server` service: build from root with `artifacts/api-server/Dockerfile`, env vars (PORT, DATABASE_URL, JWT_SECRET, RAG_SERVICE_URL, S3_BUCKET, AWS_*), depends on postgres+rag-service
  - [x] Named volumes: `postgres_data`, `pageindex_workspace`
- [x] `.env.example` (repo root) — document all required env vars:
  - [x] `POSTGRES_PASSWORD` (required)
  - [x] `JWT_SECRET` (required)
  - [x] `RAG_INTERNAL_SECRET` (required in prod)
  - [x] `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`
  - [x] `S3_BUCKET`
  - [x] `BEDROCK_CHAT_MODEL_ID`
  - [x] `PAGEINDEX_MODEL`
  - [x] `CORS_ORIGINS`

**Status:** `[x] Complete` — PR: anker-cloud/maschinenbau-v3#5

---

## Unit 6 — S3 Storage: rag-service (Python)

> Replace the Replit GCS sidecar download with direct boto3 S3 GetObject.

- [x] `artifacts/rag-service/app/config.py` — add `S3_BUCKET = os.environ.get("S3_BUCKET", "")`
- [x] `artifacts/rag-service/app/storage.py` — full rewrite:
  - [x] Remove `requests`, Replit sidecar URL, GCS path parsing, `_signed_download_url()`
  - [x] Import `boto3` and `AWS_REGION`, `S3_BUCKET` from config
  - [x] `download_object(file_path: str) -> bytes`:
    - Strip `/objects/` prefix → S3 key
    - `boto3.client("s3").get_object(Bucket=S3_BUCKET, Key=key)`
    - Return `obj["Body"].read()`
  - [x] Raise `ValueError` for unexpected paths, `RuntimeError` if `S3_BUCKET` not set

**Status:** `[x] Complete` — PR: anker-cloud/maschinenbau-v3#6

---

## Unit 7 — S3 Storage: api-server (TypeScript)

> Replace `@google-cloud/storage` + Replit sidecar with `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`.

- [x] `artifacts/api-server/package.json` — add `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`
- [x] `artifacts/api-server/package.json` — remove `@google-cloud/storage`
- [x] `artifacts/api-server/src/lib/objectStorage.ts` — full rewrite:
  - [x] Remove `Storage`, `File` from `@google-cloud/storage`, remove Replit sidecar fetch
  - [x] Import `S3Client`, `GetObjectCommand`, `HeadObjectCommand` from `@aws-sdk/client-s3`
  - [x] Import `getSignedUrl` from `@aws-sdk/s3-request-presigner`
  - [x] `getObjectEntityUploadURL()` → S3 presigned PUT URL for `uploads/<uuid>` key
  - [x] `normalizeObjectEntityPath(rawPath)` → strip S3 URL prefix → `/objects/<key>`
  - [x] `getObjectEntityFile(objectPath)` → return `{ bucket, key }` metadata (replace GCS `File`)
  - [x] `downloadObject(file)` → stream S3 object to Response
  - [x] `searchPublicObject(filePath)` → S3 HeadObject check under `public/` prefix
  - [x] Read `S3_BUCKET` from `process.env.S3_BUCKET`
  - [x] Read `AWS_REGION` from `process.env.AWS_REGION`

**Status:** `[x] Complete` — PR: anker-cloud/maschinenbau-v3#7

---

## Final Verification

- [ ] `docker compose build` completes without errors
- [ ] `docker compose up -d` starts all 4 services
- [ ] `curl http://localhost:8080/health` → `{"status":"ok"}`
- [ ] `curl http://localhost:8002/health` → `{"status":"ok"}`
- [ ] Login as `admin@sturtz.com` succeeds
- [ ] Presigned S3 upload URL is generated
- [ ] PDF upload to S3 works
- [ ] Document ingestion reaches `ready` status (pageindex service called via HTTP)
- [ ] Chat response returns citations

---

## Progress Summary

| Unit | Description | Status | PR |
|------|-------------|--------|----|
| 1 | PageIndex HTTP client (pageindex_runner.py) | ✅ Complete | #1 |
| 2 | Remove vendored _pageindex + pyproject cleanup | ✅ Complete | #2 |
| 3 | rag-service Dockerfile | ✅ Complete | #3 |
| 4 | api-server Dockerfile | ✅ Complete | #4 |
| 5 | Root docker-compose.yml + .env.example | ✅ Complete | #5 |
| 6 | S3 storage — rag-service (Python) | ✅ Complete | #6 |
| 7 | S3 storage — api-server (TypeScript) | ✅ Complete | #7 |
