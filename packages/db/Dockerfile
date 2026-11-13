# syntax=docker/dockerfile:1
# LIFTOFF migrasi database (Tahap 10b) — container sekali jalan, dijalankan role PEMILIK
# (DATABASE_URL) sebelum aplikasi start:
#   1. prisma migrate deploy  → skema + role grup liftoff_api/worker/signer (F4)
#   2. scripts/app-roles.ts   → LOGIN + password role per aplikasi dari API_/WORKER_/SIGNER_DATABASE_URL
# Build dari ROOT repo: docker build -f packages/db/Dockerfile -t liftoff-migrate .
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Prisma memilih binary schema engine berdasarkan versi OpenSSL (tidak ada di image slim).
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN --mount=type=cache,id=liftoff-pnpm,target=/pnpm/store pnpm install --frozen-lockfile
# Paket db + Prisma CLI (devDependency) dengan layout datar; client tidak dibutuhkan di sini.
RUN --mount=type=cache,id=liftoff-pnpm,target=/pnpm/store \
    pnpm --filter @liftoff/db deploy --legacy --ignore-scripts \
      --config.node-linker=hoisted /out \
 && rm -rf /out/src
# --ignore-scripts melewati unduhan schema engine; unduh sekarang (saat build), karena
# container berjalan sebagai user non-root dan tidak boleh menulis ke node_modules.
RUN cd /out && node_modules/.bin/prisma version

FROM base AS runtime
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn*
ENV NODE_ENV=production PRISMA_HIDE_UPDATE_MESSAGE=1
WORKDIR /app
COPY --from=build /out ./
USER node
# app-roles.ts dijalankan langsung oleh Node (type stripping bawaan Node ≥ 23.6).
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node scripts/app-roles.ts"]
