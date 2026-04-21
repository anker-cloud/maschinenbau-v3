# -------- Build stage --------
FROM node:24-slim AS builder

WORKDIR /app

RUN npm install -g pnpm@9

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY lib/ ./lib/
COPY artifacts/api-server/ ./artifacts/api-server/

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @workspace/api-server run build

# Deploy stage: creates a self-contained directory with all runtime dependencies
RUN pnpm --filter @workspace/api-server deploy --prod /deploy

# -------- Runtime stage --------
FROM node:24-slim

WORKDIR /app

COPY --from=builder /app/artifacts/api-server/dist ./dist
COPY --from=builder /deploy/node_modules ./node_modules

EXPOSE 8080

CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
