# syntax=docker/dockerfile:1
# Jetlisans Admin — Next.js (standalone, Node 22).
# Kök bağlamdan build edilir: docker build -f apps/admin/Dockerfile .

FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS build
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_OUTPUT_STANDALONE=1
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* turbo.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/admin/package.json ./apps/admin/
RUN pnpm install --frozen-lockfile || pnpm install
COPY packages/shared ./packages/shared
COPY apps/admin ./apps/admin
RUN pnpm --filter @jetlisans/shared build \
  && pnpm --filter @jetlisans/admin build

FROM node:22-slim AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
# Next standalone çıktısı: sunucu + gerekli node_modules.
COPY --from=build /app/apps/admin/.next/standalone ./
COPY --from=build /app/apps/admin/.next/static ./apps/admin/.next/static
COPY --from=build /app/apps/admin/public ./apps/admin/public
EXPOSE 3000
CMD ["node", "apps/admin/server.js"]
