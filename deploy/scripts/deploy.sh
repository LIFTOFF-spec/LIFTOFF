#!/bin/sh
# Pasang / update / rollback LIFTOFF (Tahap 10b). Jalankan dari folder deploy/:
#   sh scripts/deploy.sh            # build kode saat ini (tag = commit git), migrasi, jalankan
#   sh scripts/deploy.sh <tag>      # ROLLBACK: jalankan lagi image tag lama (tanpa build)
#   sh scripts/deploy.sh --list     # daftar rilis yang pernah dipasang
#   sh scripts/deploy.sh --prune    # hapus image lama, simpan 3 rilis terakhir (untuk rollback)
#   sh scripts/deploy.sh --preflight # cek siap-nyala mainnet, HANYA MEMBACA (tanpa transaksi)
# Tag aktif disimpan sebagai LIFTOFF_TAG di deploy/.env supaya perintah docker compose
# berikutnya (logs, restart, ps) memakai image yang sama.
set -eu
cd "$(dirname "$0")/.."
COMPOSE="docker compose -f docker-compose.prod.yml"

[ -f .env ] || { echo "deploy/.env belum ada: jalankan dulu sh scripts/generate-env.sh"; exit 1; }
get() { sed -n "s/^$1=//p" .env | tail -n 1; }

if [ "${1:-}" = "--list" ]; then
  cat releases.log 2>/dev/null || echo "(belum ada rilis)"
  exit 0
fi

if [ "${1:-}" = "--prune" ]; then
  # Simpan tag aktif + 3 rilis terakhir (untuk rollback); image liftoff-* lain dihapus,
  # lalu cache build yang lebih tua dari 7 hari.
  keep=" $(get LIFTOFF_TAG) $(tail -n 3 releases.log 2>/dev/null | awk '{print $2}' | tr '\n' ' ') "
  docker images --format '{{.Repository}}:{{.Tag}}' | grep '^liftoff-' | while read -r ref; do
    case "$keep" in
      *" ${ref#*:} "*) ;;
      *) echo "hapus $ref"; docker rmi "$ref" > /dev/null || true ;;
    esac
  done
  docker image prune -f > /dev/null
  docker builder prune -f --filter until=168h
  exit 0
fi

# Pemeriksaan siap-nyala (hanya membaca; image khusus, tidak butuh stack jalan). Hasil = kode keluar.
run_preflight() {
  PF_TAG=$(git rev-parse --short HEAD 2>/dev/null || echo latest)
  LIFTOFF_TAG=$PF_TAG $COMPOSE --profile preflight build preflight
  LIFTOFF_TAG=$PF_TAG $COMPOSE --profile preflight run --rm --no-deps preflight
}

if [ "${1:-}" = "--preflight" ]; then
  run_preflight
  exit $?
fi

# Kunci mainnet: hanya devnet kecuali SEMUA syarat tertulis di deploy/.env (docs/DEPLOY.md §12).
# LIFTOFF_MAINNET_APPROVED dibaca dari .env, bukan dari shell: container yang di-restart sendiri
# (mis. pause darurat) harus tetap menerimanya, dan kode aplikasi juga memeriksanya saat start.
cluster=$(get SOLANA_CLUSTER)
stonk=$(get STONKFUN_MAINNET_ENABLED)
mainnet=0
if [ "${cluster:-devnet}" != "devnet" ] || [ "${stonk:-0}" != "0" ]; then
  if [ "$(get LIFTOFF_MAINNET_APPROVED)" != "ya" ]; then
    echo "DITOLAK: SOLANA_CLUSTER=${cluster} / STONKFUN_MAINNET_ENABLED=${stonk}."
    echo "Mainnet terkunci: butuh persetujuan tertulis pemilik, lalu LIFTOFF_MAINNET_APPROVED=ya di deploy/.env (docs/DEPLOY.md §12)."
    exit 1
  fi
  if [ "$cluster" != "mainnet-beta" ] || [ "$stonk" != "1" ]; then
    echo "DITOLAK: mainnet butuh SOLANA_CLUSTER=mainnet-beta DAN STONKFUN_MAINNET_ENABLED=1 (sekarang: ${cluster} / ${stonk})."
    exit 1
  fi
  # Syarat server mainnet (Tahap 11a, docs/MAINNET_TEST.md): di belakang Cloudflare, alert
  # Telegram aktif (kecuali dilepas pemilik: ALERTS_WAIVED=ya), RPC cadangan, dan pubkey master.
  missing=""
  [ "$(get EDGE_MODE)" = "cloudflare" ] || missing="$missing EDGE_MODE=cloudflare"
  for v in RPC_URL RPC_BACKUP_URL MASTER_WALLET_PUBKEY; do
    [ -n "$(get "$v")" ] || missing="$missing $v"
  done
  if [ "$(get ALERTS_WAIVED)" = "ya" ]; then
    echo "PERINGATAN: alert dilepas pemilik (ALERTS_WAIVED=ya). Masalah hanya tercatat di log; cek /api/health rutin."
  else
    for v in ALERT_TELEGRAM_BOT_TOKEN ALERT_TELEGRAM_CHAT_ID; do
      [ -n "$(get "$v")" ] || missing="$missing $v"
    done
  fi
  if [ -n "$missing" ]; then
    echo "DITOLAK: server mainnet belum lengkap:$missing (lihat deploy/.env.mainnet.example)."
    exit 1
  fi
  mainnet=1
fi

# Mode depan Caddy: direct (default) atau cloudflare (docs/DEPLOY.md §Cloudflare).
case "$(get EDGE_MODE)" in
  "" | direct) ;;
  cloudflare)
    [ -f caddy/edge/cloudflare-global.caddy ] && [ -f caddy/edge/cloudflare-site.caddy ] \
      || { echo "caddy/edge/cloudflare-*.caddy tidak ada: sh scripts/update-cloudflare-ips.sh"; exit 1; }
    ;;
  *) echo "EDGE_MODE harus direct atau cloudflare (sekarang: $(get EDGE_MODE))."; exit 1 ;;
esac

# Domain lama sesudah pindah domain (docs/DEPLOY.md §Pindah domain).
case "$(get LEGACY_MODE)" in
  "" | off) ;;
  on)
    [ -n "$(get LEGACY_DOMAIN)" ] || { echo "LEGACY_MODE=on butuh LEGACY_DOMAIN."; exit 1; }
    [ "$(get LEGACY_DOMAIN)" != "$(get DOMAIN)" ] \
      || { echo "LEGACY_DOMAIN tidak boleh sama dengan DOMAIN."; exit 1; }
    ;;
  *) echo "LEGACY_MODE harus on atau off (sekarang: $(get LEGACY_MODE))."; exit 1 ;;
esac

if [ -n "$(get SIGNER_KEYPAIR_HOST_PATH)" ] && [ ! -f "$(get SIGNER_KEYPAIR_HOST_PATH)" ]; then
  echo "File keypair tidak ditemukan di SIGNER_KEYPAIR_HOST_PATH ($(get SIGNER_KEYPAIR_HOST_PATH))."
  exit 1
fi

if [ $# -ge 1 ]; then
  TAG=$1
  for img in api web signer worker migrate; do
    docker image inspect "liftoff-$img:$TAG" > /dev/null 2>&1 \
      || { echo "image liftoff-$img:$TAG tidak ada (lihat: sh scripts/deploy.sh --list)"; exit 1; }
  done
  echo "Rollback ke $TAG (tanpa build)"
else
  TAG=$(git rev-parse --short HEAD)
  [ -z "$(git status --porcelain -- .. 2>/dev/null)" ] || TAG="$TAG-local"
  # Deploy baru ke mainnet wajib lolos pemeriksaan dulu. Rollback (cabang atas) tidak, supaya
  # jalan darurat tidak tertahan gangguan RPC sesaat.
  if [ "$mainnet" = "1" ]; then
    echo "Mainnet: menjalankan pemeriksaan siap-nyala (hanya membaca) ..."
    run_preflight || { echo "DITOLAK: pemeriksaan siap-nyala gagal, tidak ada yang diubah."; exit 1; }
  fi
  echo "Build image tag $TAG ..."
  LIFTOFF_TAG=$TAG $COMPOSE build
fi

# Simpan tag aktif di .env (ganti baris lama atau tambahkan).
if grep -q '^LIFTOFF_TAG=' .env; then
  sed -i "s/^LIFTOFF_TAG=.*/LIFTOFF_TAG=$TAG/" .env
else
  printf '\n# Diisi otomatis oleh scripts/deploy.sh (image yang sedang jalan).\nLIFTOFF_TAG=%s\n' "$TAG" >> .env
fi

$COMPOSE up -d --remove-orphans
# Image tanpa tag (sisa build sebelumnya) dibuang supaya disk tidak penuh.
docker image prune -f > /dev/null
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $TAG" >> releases.log
echo "Selesai. Status: $COMPOSE ps"
