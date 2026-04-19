# -------- Build stage --------
FROM node:24-slim AS builder

WORKDIR /app

RUN npm install -g pnpm@9

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY lib/ ./lib/
COPY artifacts/api-server/ ./artifacts/api-server/

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @workspace/api-server run build

# -------- Runtime stage --------
FROM node:24-slim

WORKDIR /app

COPY --from=builder /app/artifacts/api-server/dist ./dist

# Several packages are externalized from the bundle (nodemailer, @google-cloud/*, etc.)
# and must be resolvable at runtime via the standard node_modules lookup chain.
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 8080

CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
