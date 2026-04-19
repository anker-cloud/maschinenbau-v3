# CLAUDE.md — Sturtz Maschinenbau Support Chatbot

## Project Overview

Internal RAG-powered support chatbot that answers technical questions from machinery and parts manuals. Admins upload PDFs; users ask questions and get cited answers grounded in the document text.

**Key architectural innovation:** Vectorless RAG — no vector similarity search. Instead, Claude reads a hierarchical tree-of-contents (built by PageIndex) to select relevant pages, then answers from the full page text with inline citations. This avoids embedding drift and achieves high factual accuracy.

---

## Current Status (as of 2026-04-19)

**Migration complete — code merged, awaiting first `docker compose build` verification.**

All 7 migration units have been implemented and merged to `main`:

| Unit | Change | Status |
|------|--------|--------|
| 1 | `pageindex_runner.py` — HTTP client replaces in-process vendored call | ✅ Merged |
| 2 | Deleted `_pageindex/` vendored library; removed `litellm`, `pageindex` from `pyproject.toml` | ✅ Merged |
| 3 | `artifacts/rag-service/Dockerfile` — new containerization | ✅ Merged |
| 4 | `artifacts/api-server/Dockerfile` — two-stage build | ✅ Merged |
| 5 | `docker-compose.yml` + `.env.example` at repo root | ✅ Merged |
| 6 | `storage.py` — replaced Replit GCS sidecar with boto3 S3 | ✅ Merged |
| 7 | `objectStorage.ts` — replaced `@google-cloud/storage` with `@aws-sdk/client-s3` | ✅ Merged |

**To bring up the full stack:**
```bash
git pull origin main
# Fill in .env (see Environment Variables section)
docker compose build
docker compose up -d
```

---

## Architecture

The application runs as **two independently deployed Docker services** + a frontend:

```
Browser
  │  JWT httpOnly cookie (sturtz_token)
  ▼
API Server  :8080  (Express 5 / Node 24 / TypeScript)
  │  X-Internal-Secret + RAG_SERVICE_URL
  ▼
RAG Service  :8000  (FastAPI / Python 3.12)
  │  httpx HTTP calls
  ▼
PageIndex Service  :8002  (FastAPI / Python — standalone microservice)
  │  AWS credentials (env vars only)
  ▼
AWS Bedrock  (Claude LLM for PageIndex tree + chat answering)

Admin Upload:
  Browser ──presigned PUT URL──► AWS S3 (direct, API server never touches file bytes)

RAG/Ingestion download:
  RAG Service ──boto3 GetObject──► AWS S3
```

**All AWS credentials come from the `.env` file only.** No `~/.aws` mounts, no `aws configure`.

---

## Monorepo Structure

```
main-app/
├── artifacts/
│   ├── api-server/       # Express 5 / Node 24 / TypeScript — auth, DB, orchestration
│   │   ├── Dockerfile    # Two-stage build (Node 24 builder → slim runtime)
│   │   └── src/lib/objectStorage.ts  # AWS S3 presigned URLs + streaming
│   ├── rag-service/      # FastAPI / Python 3.12 — ingestion, vectorless retrieval
│   │   ├── Dockerfile    # python:3.12-slim + uv, build context = repo root
│   │   └── app/
│   │       ├── storage.py          # boto3 S3 download
│   │       └── pageindex_runner.py # HTTP client → PageIndex service
│   ├── chat-web/         # React 19 / Vite / TypeScript — UI
│   └── mockup-sandbox/   # Component preview (legacy, minimal use)
├── lib/
│   ├── db/               # Drizzle ORM schema + PostgreSQL pool (source of truth for DB)
│   ├── api-spec/         # OpenAPI spec (source of truth for all API types)
│   ├── api-zod/          # Zod schemas — GENERATED from api-spec, do not edit manually
│   └── api-client-react/ # TanStack Query hooks — GENERATED from api-spec, do not edit manually
├── pageindex/            # Standalone PageIndex Docker microservice
├── docker-compose.yml    # Orchestrates postgres + pageindex + rag-service + api-server
├── .env.example          # All required env vars documented
├── scripts/              # Utility scripts
├── pnpm-workspace.yaml
├── pyproject.toml        # Python dependencies for rag-service
└── tsconfig.base.json
```

---

## Running the Stack

### Docker (primary — local + AWS deployment)

```bash
cp .env.example .env      # Fill in required values
docker compose build      # Build all services
docker compose up -d      # Start postgres, pageindex, rag-service, api-server
docker compose logs -f    # Tail logs

# Health checks
curl http://localhost:8080/health   # api-server
curl http://localhost:8002/health   # pageindex
```

### Local Development (no Docker)

```bash
# TypeScript / Node
pnpm run typecheck
pnpm run build
pnpm --filter @workspace/api-server run dev      # API server on :8080
pnpm --filter @workspace/chat-web run dev        # Frontend on :3000

# Python RAG Service
uvicorn artifacts/rag-service/app.main:app --reload --port 8000

# OpenAPI codegen (after editing lib/api-spec)
pnpm --filter @workspace/api-spec run codegen

# Database
pnpm --filter @workspace/db run push             # Push schema (non-destructive)
pnpm --filter @workspace/db run push-force       # Force push (destructive, dev only)
pnpm --filter @workspace/api-server run seed-admin  # Create default admin user
```

---

## Environment Variables

All variables are set in `.env` at the repo root. See `.env.example` for the full template.

### Required for any environment

| Variable | Notes |
|----------|-------|
| `POSTGRES_PASSWORD` | Choose any strong password; initializes the DB container |
| `JWT_SECRET` | Long random string for JWT signing |
| `RAG_INTERNAL_SECRET` | Shared secret between api-server and rag-service |
| `AWS_ACCESS_KEY_ID` | IAM credentials with S3 + Bedrock access |
| `AWS_SECRET_ACCESS_KEY` | IAM credentials |
| `AWS_REGION` | Default: `us-east-1` |
| `S3_BUCKET` | S3 bucket name for document uploads and downloads |

### Optional / defaults

| Variable | Default | Notes |
|----------|---------|-------|
| `BEDROCK_CHAT_MODEL_ID` | `global.anthropic.claude-sonnet-4-5-20250929-v1:0` | Claude model for chat |
| `PAGEINDEX_MODEL` | `bedrock/global.anthropic.claude-sonnet-4-6` | Claude model for PageIndex tree building |
| `POSTGRES_USER` | `postgres` | DB username |
| `POSTGRES_DB` | `sturtz` | DB name |
| `CORS_ORIGINS` | allow all | Comma-separated origins; restrict in production |
| `SEED_ADMIN_EMAIL` | `admin@sturtz.com` | Admin account created on startup |
| `SEED_ADMIN_PASSWORD` | `changeme123` | **Change in production** |
| `SMTP_HOST/USER/PASS/PORT/FROM` | — | Optional email alerts for ingestion failures |

> `DATABASE_URL` is constructed automatically by docker-compose from `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`. Do not set it manually when using Docker.

---

## Database Schema

Tables (Drizzle ORM, `lib/db/src/schema/`):

- **`users`** — `id`, `email`, `name`, `passwordHash`, `role` (admin/user), `createdAt`, `passwordChangedAt`
- **`documents`** — `id`, `title`, `filename`, `filePath` (S3 key as `/objects/<key>`), `fileType`, `size`, `status` (pending/ingesting/ready/failed), `ingestProgress`, `ingestTotalPages`, `treeStructure` (JSONB), `uploadedBy`, `createdAt`
- **`document_chunks`** — `id`, `documentId`, `pageNumber`, `chunkText`, `embedding` (vector[1024] — **column exists but is NOT populated**), `metadata` (JSONB), `createdAt`
- **`conversations`** — `id`, `userId`, `title`, `createdAt`
- **`messages`** — `id`, `conversationId`, `role` (user/assistant), `content`, `citations` (JSONB array of `{documentId, documentTitle, pageNumber, snippet}`), `createdAt`
- **`sessions`** — JWT refresh token store for session rotation

> **Vectorless note:** `document_chunks.embedding` is defined in the schema for future use but is never written to. All retrieval uses `documents.tree_structure` (JSONB) and `document_chunks.chunk_text`.

---

## Auth

- JWT in httpOnly cookie `sturtz_token` (access token) + refresh token cookie
- Roles: `admin` (manage users + documents), `user` (chat only)
- Admin routes: `/api/admin/*` protected by `requireAdmin` middleware
- Conversations are user-scoped (users cannot access each other's history)
- `JWT_SECRET` **must** be set in production
- Seed admin (`ensureAdminUser()`) runs on every API server startup; safe to re-run

---

## Document Ingestion Pipeline

1. Admin requests presigned upload URL → `POST /api/storage/uploads/request-url`
2. Browser uploads file **directly to S3** via presigned PUT URL (bypasses API server)
3. Admin registers document → `POST /api/admin/documents` (includes S3 path as `/objects/<key>`)
4. API server calls `POST /ingest` on RAG service (202 Accepted, async)
5. RAG service background worker (serial, single thread):
   - Downloads PDF from S3 via `boto3.client("s3").get_object()`
   - Parses document (PDF, DOCX, TXT, MD, HTML, PPTX)
   - Detects scanned PDFs (avg chars/page < 50) — extracts text via AI if scanned
   - Calls `POST http://pageindex:8000/documents` (multipart) → gets `doc_id`
   - Calls `GET http://pageindex:8000/documents/{doc_id}/structure` → gets tree JSON
   - Stores tree in `documents.tree_structure`, full page text in `document_chunks`
   - Updates `documents.status` to `ready` or `failed`
6. On failure, email alert sent to all admin users (if SMTP configured)

> **Do not add concurrency to the ingestion worker.** The serial design is intentional to avoid race conditions on document status updates.

---

## Chat / RAG Flow (Two-Step Reasoning)

1. User message arrives at `POST /api/conversations/:id/messages`
2. API server proxies to RAG service with `X-Internal-Secret`
3. RAG service — **Step 1 (Planner):** Claude reads `treeStructure` from all relevant documents and selects up to ~8 page numbers
4. RAG service — **Step 2 (Answerer):** Claude reads selected page texts from `document_chunks` and generates a grounded answer with `[n]` citation markers
5. Citations stored as JSONB in `messages.citations`; frontend renders them as clickable badges → `GET /api/documents/:id/view?page=N`

---

## OpenAPI Codegen — Critical Convention

`lib/api-spec/` is the **single source of truth** for all API types.

After any change to the OpenAPI spec:

```bash
pnpm --filter @workspace/api-spec run codegen
```

Regenerates `lib/api-zod/` and `lib/api-client-react/`. **Never manually edit these generated files.**

---

## Critical Files

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Orchestrates all 4 services |
| `.env.example` | Documents all required env vars |
| `artifacts/api-server/src/index.ts` | API server entry point |
| `artifacts/api-server/src/routes/` | All Express route handlers |
| `artifacts/api-server/src/lib/objectStorage.ts` | S3 presigned URLs, upload/download |
| `artifacts/rag-service/app/main.py` | FastAPI app + ingest queue + chat endpoint |
| `artifacts/rag-service/app/config.py` | All RAG environment variable definitions |
| `artifacts/rag-service/app/storage.py` | S3 download via boto3 |
| `artifacts/rag-service/app/pageindex_runner.py` | HTTP client → PageIndex service |
| `artifacts/rag-service/app/bedrock.py` | AWS Bedrock LLM + embedding client |
| `artifacts/rag-service/app/db.py` | PostgreSQL helpers for RAG service |
| `artifacts/rag-service/app/parsing.py` | Document parsing (PDF, DOCX, etc.) |
| `pageindex/server.py` | Standalone PageIndex FastAPI service |
| `lib/db/src/schema/` | Drizzle ORM table definitions |
| `lib/api-spec/` | OpenAPI spec — edit here, then run codegen |
| `artifacts/chat-web/src/pages/` | Login, Chat, Admin pages |

---

## Gotchas & Conventions

- **pnpm workspaces:** Always use `pnpm --filter @workspace/<name> run <script>`. Running scripts from the wrong directory will fail silently.

- **PageIndex is now a separate service:** `pageindex/` runs as its own Docker container. `artifacts/rag-service/app/_pageindex/` (the old vendored copy) has been deleted. Do not re-add it.

- **S3 key format:** Files are stored under `uploads/<uuid>` in S3. The internal path representation used across the app is `/objects/uploads/<uuid>`. `storage.py` strips the `/objects/` prefix before calling S3.

- **AWS credentials via env only:** Never add `~/.aws` volume mounts to docker-compose. All credentials come from the `.env` file (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`).

- **Embedding column is a stub:** `document_chunks.embedding` exists in the schema with pgvector but is never written to. Don't build features that assume it's populated.

- **RAG_INTERNAL_SECRET must match:** Both api-server and rag-service must share the same value. Enforced only when `NODE_ENV=production`.

- **Docker build context is repo root:** Both `artifacts/rag-service/Dockerfile` and `artifacts/api-server/Dockerfile` require build context `.` (repo root) because `pyproject.toml` and `pnpm-workspace.yaml` live there. This is already set correctly in `docker-compose.yml`.

- **Frontend brand palette:** `#4DB4DE` (primary), `#2563EB` (CTA), `#283745` (text). Maintain these in any UI changes.

- **Generated clients:** `lib/api-client-react` and `lib/api-zod` are checked in for convenience but are always regenerated from the spec. Treat them as build artifacts.
