# -------- Build stage --------
FROM node:24-slim AS builder

WORKDIR /app

RUN npm install -g pnpm@9

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY lib/ ./lib/
COPY artifacts/chat-web/ ./artifacts/chat-web/

RUN pnpm install --frozen-lockfile

ENV BASE_PATH=/
ENV PORT=3000
ENV NODE_ENV=production

RUN pnpm --filter @workspace/chat-web run build

# -------- Runtime stage --------
FROM nginx:alpine

COPY --from=builder /app/artifacts/chat-web/dist/public /usr/share/nginx/html
COPY --from=builder /app/artifacts/chat-web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
