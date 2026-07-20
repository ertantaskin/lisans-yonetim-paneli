# syntax=docker/dockerfile:1
# Jetlisans API — NestJS + Fastify (Node 22 LTS, §1).
# Kök bağlamdan build edilir: docker build -f apps/api/Dockerfile .

FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# ── Bağımlılıklar + build ───────────────────────────────────────────────────
FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* turbo.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
RUN pnpm install --frozen-lockfile || pnpm install
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
RUN pnpm --filter @jetlisans/shared build \
  && pnpm --filter @jetlisans/api build

# ── Runtime ─────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/api
EXPOSE 3001
# Migration compose command'ında koşturulur; imaj yalnız servisi başlatır.
CMD ["node", "dist/main.js"]
