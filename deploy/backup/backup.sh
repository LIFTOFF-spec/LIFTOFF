#!/bin/sh
# Backup LIFTOFF (Tahap 10b), dijalankan container `backup` (image postgres:17-alpine, user 70).
#   - pg_dump format custom (-Fc) database liftoff  → /backups/db-<waktu UTC>.dump
#   - arsip volume upload gambar                    → /backups/uploads-<waktu UTC>.tar.gz
#   - file lebih tua dari BACKUP_RETENTION_DAYS hari dihapus
# Loop tiap BACKUP_INTERVAL_HOURS jam. Sekali jalan (manual): sh /scripts/backup.sh --once
# Restore: deploy/scripts/restore.sh (docs/DEPLOY.md §Backup).
set -eu
INTERVAL=$(( ${BACKUP_INTERVAL_HOURS:-24} * 3600 ))
RETENTION=${BACKUP_RETENTION_DAYS:-14}
DIR=/backups

run() {
  ts=$(date -u +%Y%m%d-%H%M%S)
  pg_dump -Fc -f "$DIR/db-$ts.dump.part"
  mv "$DIR/db-$ts.dump.part" "$DIR/db-$ts.dump"
  tar -czf "$DIR/uploads-$ts.tar.gz.part" -C /uploads .
  mv "$DIR/uploads-$ts.tar.gz.part" "$DIR/uploads-$ts.tar.gz"
  find "$DIR" -maxdepth 1 -type f \( -name 'db-*.dump' -o -name 'uploads-*.tar.gz' \) \
    -mtime +"$RETENTION" -delete
  rm -f "$DIR"/*.part
  echo "{\"service\":\"backup\",\"msg\":\"backup selesai\",\"time\":\"$ts\",\"db\":\"db-$ts.dump\",\"dbBytes\":$(wc -c < "$DIR/db-$ts.dump")}"
}

if [ "${1:-}" = "--once" ]; then
  run
  exit 0
fi

# Beri waktu database siap setelah server boot, lalu loop.
sleep 60
while true; do
  run || echo '{"service":"backup","level":"warn","msg":"ALERT: backup GAGAL"}'
  sleep "$INTERVAL"
done
