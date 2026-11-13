#!/bin/sh
# Pulihkan database (dan opsional upload gambar) dari backup (Tahap 10b). Dari folder deploy/:
#   sh scripts/restore.sh /var/backups/liftoff/db-20261031-020000.dump \
#                         [/var/backups/liftoff/uploads-20261031-020000.tar.gz]
# MENIMPA data yang ada. Semua aplikasi dihentikan dulu, signer ikut berhenti (tidak ada transaksi
# selama pemulihan). Setelah selesai aplikasi dijalankan lagi dengan image yang sama.
set -eu
cd "$(dirname "$0")/.."
COMPOSE="docker compose -f docker-compose.prod.yml"
DB_FILE=${1:?pemakaian: restore.sh <db-*.dump> [uploads-*.tar.gz]}
UP_FILE=${2:-}
[ -f "$DB_FILE" ] || { echo "file tidak ada: $DB_FILE"; exit 1; }
[ -z "$UP_FILE" ] || [ -f "$UP_FILE" ] || { echo "file tidak ada: $UP_FILE"; exit 1; }

printf 'Data sekarang akan DITIMPA oleh %s. Ketik PULIHKAN untuk lanjut: ' "$DB_FILE"
read -r answer
[ "$answer" = "PULIHKAN" ] || { echo "dibatalkan"; exit 1; }

$COMPOSE stop caddy web api worker-launch worker-indexer worker-economic worker-monitor signer backup
$COMPOSE up -d --wait postgres
# Pastikan role per aplikasi ada (dump hanya berisi isi database, bukan role cluster).
$COMPOSE run --rm migrate

echo "Memulihkan database ..."
$COMPOSE exec -T postgres pg_restore -U liftoff -d liftoff --clean --if-exists --no-owner \
  --single-transaction --exit-on-error < "$DB_FILE"

if [ -n "$UP_FILE" ]; then
  echo "Memulihkan upload gambar ..."
  # Arsip dialirkan lewat stdin (tanpa bind mount file) seperti pg_restore di atas.
  docker run --rm -i --user 1000:1000 -v "${COMPOSE_PROJECT_NAME:-liftoff}_uploads":/uploads \
    postgres:17-alpine sh -c 'find /uploads -mindepth 1 -delete && tar -xzf - -C /uploads' \
    < "$UP_FILE"
fi

# Jalankan lagi semuanya (migrasi berjalan ulang: tidak ada yang baru → no-op).
$COMPOSE up -d
echo "Pulih. Cek: $COMPOSE ps  dan  curl -s https://\$DOMAIN/api/health/status"
