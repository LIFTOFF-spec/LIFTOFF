# syntax=docker/dockerfile:1
# LIFTOFF Web (Next.js, server mandiri/standalone) — image produksi (Tahap 10b). Build dari ROOT repo:
#   docker build -f apps/web/Dockerfile -t liftoff-web .
# NEXT_PUBLIC_* dan API_INTERNAL_URL ditanam saat BUILD (rewrite /api/* + bundle browser).
# JANGAN isi NEXT_PUBLIC_RPC_URL dengan URL ber-API key rahasia: nilainya terlihat publik di browser.
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# Install seluruh workspace (layer sama di semua Dockerfile app → cache build dipakai bersama).
FROM base AS build
COPY . .
RUN --mount=type=cache,id=liftoff-pnpm,target=/pnpm/store pnpm install --frozen-lockfile
ARG API_INTERNAL_URL=http://api:4000
ARG NEXT_PUBLIC_SOLANA_CLUSTER=devnet
ARG NEXT_PUBLIC_RPC_URL=
ENV NEXT_TELEMETRY_DISABLED=1 API_INTERNAL_URL=${API_INTERNAL_URL} \
    NEXT_PUBLIC_SOLANA_CLUSTER=${NEXT_PUBLIC_SOLANA_CLUSTER}
# NEXT_PUBLIC_RPC_URL kosong = endpoint publik cluster (string kosong akan merusak koneksi wallet).
RUN if [ -n "$NEXT_PUBLIC_RPC_URL" ]; then export NEXT_PUBLIC_RPC_URL; else unset NEXT_PUBLIC_RPC_URL; fi \
 && pnpm --filter @liftoff/web build

FROM ${NODE_IMAGE} AS runtime
# npm/corepack tidak dibutuhkan saat jalan (permukaan serangan lebih kecil).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn*
ARG API_INTERNAL_URL=http://api:4000
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 \
    API_INTERNAL_URL=${API_INTERNAL_URL}
WORKDIR /app
# File milik root (read-only); hanya cache Next (.next/cache) yang boleh ditulis user "node".
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
RUN mkdir -p apps/web/.next/cache && chown node:node apps/web/.next/cache
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
