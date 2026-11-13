# syntax=docker/dockerfile:1
# LIFTOFF Worker — image produksi (Tahap 10b). Build dari ROOT repo:
#   docker build -f apps/worker/Dockerfile -t liftoff-worker .
# Satu image untuk semua proses worker; perintah dipilih di compose:
#   launch: node dist/index.js        | indexer: node dist/indexer-main.js
#   economic + reserve: node dist/economic-main.js | monitor: node dist/monitor-main.js
# Worker TIDAK memegang key; token signer per worker datang dari environment.
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# Install seluruh workspace (layer sama di semua Dockerfile app → cache build dipakai bersama).
FROM base AS build
COPY . .
RUN --mount=type=cache,id=liftoff-pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm --filter @liftoff/worker build
# node_modules produksi saja, layout datar (hoisted) supaya dist/*.js menemukan dependensi paket
# workspace (Raydium SDK, @prisma/client, ...). Paket workspace sendiri sudah di-bundle di dist.
RUN --mount=type=cache,id=liftoff-pnpm,target=/pnpm/store \
    pnpm --filter @liftoff/worker deploy --prod --legacy --ignore-scripts \
      --config.node-linker=hoisted /tmp/deploy \
 && mkdir /out && mv /tmp/deploy/node_modules /tmp/deploy/package.json /out/ \
 && rm -rf /out/node_modules/@liftoff \
 && sh deploy/docker/prune-node-modules.sh /out/node_modules \
 && cp -r apps/worker/dist /out/dist

FROM ${NODE_IMAGE} AS runtime
# npm/corepack tidak dibutuhkan saat jalan (permukaan serangan lebih kecil).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn*
ENV NODE_ENV=production
WORKDIR /app
# File milik root (read-only untuk user aplikasi); proses jalan sebagai user non-root "node".
COPY --from=build /out ./
USER node
CMD ["node", "dist/index.js"]
