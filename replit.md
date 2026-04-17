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
- **RAG service** (`artifacts/rag-service`): Python FastAPI at `RAG_SERVICE_URL` (default `http://127.0.0.1:8000`). Vectorless RAG using a vendored copy of the open-source [PageIndex](https://github.com/VectifyAI/PageIndex) library (`app/_pageindex/`) wired to AWS Bedrock via LiteLLM (`bedrock/<model>` strings — no OpenAI or paid PageIndex service needed). Ingest builds a tree-of-contents per document and stores it in `documents.tree_structure` along with per-page text in `document_chunks`. Chat uses two-step reasoning: (1) Claude reads the trees and picks relevant page numbers, (2) Claude answers from the actual page text with `[n]` citations. Override Bedrock model via `BEDROCK_CHAT_MODEL_ID` (default `anthropic.claude-3-haiku-20240307-v1:0`) and `PAGEINDEX_LLM_MODEL` (defaults to the same). Endpoints: `POST /ingest`, `POST /chat`, `DELETE /documents/{id}`, `GET /healthz`. Internal-only — protected by `X-Internal-Secret` header (`RAG_INTERNAL_SECRET`) in production.
- **Frontend** (`artifacts/chat-web`): React + Vite, wouter routing, TanStack Query, generated `@workspace/api-client-react` hooks. Login page, chat home with sidebar + thread + composer, citation badges that open `${BASE_URL}api/documents/{id}/view?page=N` in a new tab, admin dashboard (Users + Documents tabs) gated to `currentUser.role === 'admin'`. Auth via httpOnly cookie set by API server. Sturtz brand palette: `#4DB4DE` primary, `#2563EB` CTA, `#283745` text.

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
