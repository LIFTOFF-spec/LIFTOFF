#!/bin/sh
# Buang paket yang hanya dibutuhkan saat development dari node_modules produksi (Tahap 10b).
# Paket ini ikut terpasang sebagai peer dependency otomatis (Prisma CLI/Studio, TypeScript) padahal
# runtime hanya memakai @prisma/client + @prisma/adapter-pg (client sudah di-generate & di-bundle).
# Pemakaian: prune-node-modules.sh <dir-node_modules>
set -eu
NM="$1"
cd "$NM"
rm -rf \
  prisma @prisma/studio-core @prisma/dev @prisma/engines @prisma/fetch-engine \
  @electric-sql typescript @types .bin
# Sisa build/dokumentasi yang tidak dipakai saat jalan.
find . -type f \( -name '*.md' -o -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \
  -o -name 'CHANGELOG*' -o -name '*.tsbuildinfo' \) -delete
