# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Project: Sturtz Maschinenbau Support Chatbot

Internal support chatbot that answers technical questions from machinery/part manuals using RAG.

### Architecture
- **API server** (`artifacts/api-server`): Express 5, Node, Drizzle ORM, custom JWT auth (httpOnly cookie). Proxies chat requests to a separate Python RAG microservice.
- **RAG service** (`artifacts/rag-service`): Python FastAPI at `RAG_SERVICE_URL` (default `http://127.0.0.1:8000`). Uses AWS Bedrock for both embeddings (Titan v2, 1024-dim) and chat (Claude 3 Haiku by default; override via `BEDROCK_CHAT_MODEL_ID`). Page-aware chunking with overlap. Endpoints: `POST /ingest`, `POST /chat`, `DELETE /documents/{id}`, `GET /healthz`. Internal-only — protected by `X-Internal-Secret` header (`RAG_INTERNAL_SECRET`) in production.
- **Frontend** (Task #3, not yet built): React + Vite chat UI.

### Auth
- Custom username/password auth, JWT in httpOnly cookie (`sturtz_token`).
- Roles: `admin`, `user`. Admin-only endpoints under `/api/admin/*`.
- Seed admin: `admin@sturtz.com` / `changeme123` (override via `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`).
- `JWT_SECRET` should be set as a secret in production.

### Storage
- Uploaded documents go directly to GCS via presigned URL (`POST /api/storage/uploads/request-url`).
- Admin then registers the document via `POST /api/admin/documents`, which queues ingestion with the RAG service.
- Document view URL: `GET /api/documents/{id}/view?page=N` redirects to the underlying file with a `#page=N` anchor.

### DB schema
`users`, `documents`, `document_chunks`, `conversations`, `messages` (citations stored as jsonb).
