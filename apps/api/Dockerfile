# syntax=docker/dockerfile:1
# LIFTOFF API (Fastify) — image produksi (Tahap 10b). Build dari ROOT repo:
#   docker build -f apps/api/Dockerfile -t liftoff-api .
# Tidak ada secret/keypair di image: konfigurasi lewat environment saat container jalan.
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# Install seluruh workspace (layer sama di semua Dockerfile app → cache build dipakai bersama).
FROM base AS build
COPY . .
RUN --mount=type=cache,id=liftoff-pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm --filter @liftoff/api build
# node_modules produksi saja, layout datar (hoisted) supaya dist/*.js menemukan dependensi paket
# workspace (Raydium SDK, @prisma/client, ...). Paket workspace sendiri sudah di-bundle di dist.
RUN --mount=type=cache,id=liftoff-pnpm,target=/pnpm/store \
    pnpm --filter @liftoff/api deploy --prod --legacy --ignore-scripts \
      --config.node-linker=hoisted /tmp/deploy \
 && mkdir /out && mv /tmp/deploy/node_modules /tmp/deploy/package.json /out/ \
 && rm -rf /out/node_modules/@liftoff \
 && sh deploy/docker/prune-node-modules.sh /out/node_modules \
 && cp -r apps/api/dist /out/dist

FROM ${NODE_IMAGE} AS runtime
# npm/corepack tidak dibutuhkan saat jalan (permukaan serangan lebih kecil).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn*
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=4000 UPLOAD_DIR=/data/uploads
WORKDIR /app
# File milik root (read-only untuk user aplikasi); proses jalan sebagai user non-root "node".
COPY --from=build /out ./
# Upload gambar: volume bernama di compose; satu-satunya folder yang boleh ditulis API.
RUN mkdir -p /data/uploads && chown node:node /data/uploads
USER node
EXPOSE 4000
# 503 = "degraded" (mis. RPC/signer bermasalah) tetapi proses API hidup → tetap sehat untuk Docker.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.status===200||r.status===503?0:1),()=>process.exit(1))"]
CMD ["node", "dist/server.js"]
