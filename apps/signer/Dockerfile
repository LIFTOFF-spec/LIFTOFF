# syntax=docker/dockerfile:1
# LIFTOFF Signer (satu-satunya pemegang key master) — image produksi (Tahap 10b). Build dari ROOT repo:
#   docker build -f apps/signer/Dockerfile -t liftoff-signer .
# Keypair master TIDAK pernah ada di image: di-mount read-only saat jalan
# (deploy/docker-compose.prod.yml → /run/secrets/master-keypair.json).
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# Install seluruh workspace (layer sama di semua Dockerfile app → cache build dipakai bersama).
FROM base AS build
COPY . .
RUN --mount=type=cache,id=liftoff-pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm --filter @liftoff/signer build
# node_modules produksi saja, layout datar (hoisted) supaya dist/*.js menemukan dependensi paket
# workspace (Raydium SDK, @prisma/client, ...). Paket workspace sendiri sudah di-bundle di dist.
RUN --mount=type=cache,id=liftoff-pnpm,target=/pnpm/store \
    pnpm --filter @liftoff/signer deploy --prod --legacy --ignore-scripts \
      --config.node-linker=hoisted /tmp/deploy \
 && mkdir /out && mv /tmp/deploy/node_modules /tmp/deploy/package.json /out/ \
 && rm -rf /out/node_modules/@liftoff \
 && sh deploy/docker/prune-node-modules.sh /out/node_modules \
 && cp -r apps/signer/dist /out/dist

FROM ${NODE_IMAGE} AS runtime
# npm/corepack tidak dibutuhkan saat jalan (permukaan serangan lebih kecil).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn*
ENV NODE_ENV=production SIGNER_HOST=0.0.0.0 SIGNER_PORT=4100 \
    SIGNER_KEYPAIR_PATH=/run/secrets/master-keypair.json
WORKDIR /app
# File milik root (read-only untuk user aplikasi); proses jalan sebagai user non-root "node".
COPY --from=build /out ./
USER node
# Port HANYA untuk jaringan internal Docker; JANGAN pernah di-publish ke host/internet.
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4100/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Pause darurat di container: node dist/cli.js pause "alasan" | resume "alasan" | status
CMD ["node", "dist/index.js"]
