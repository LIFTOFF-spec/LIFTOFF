#!/bin/sh
# Buat deploy/.env dari template dengan password & token ACAK (Tahap 10b; --mainnet Tahap 11a).
#   sh scripts/generate-env.sh             (staging devnet: dari .env.production.example)
#   sh scripts/generate-env.sh --mainnet   (server mainnet baru: dari .env.mainnet.example)
# Jalankan dari folder deploy/. Tidak menimpa deploy/.env yang sudah ada. Nilai tidak pernah
# dicetak ke layar.
set -eu
cd "$(dirname "$0")/.."

SOURCE=.env.production.example
NEXT="DOMAIN, ACME_EMAIL, SIGNER_KEYPAIR_HOST_PATH"
if [ "${1:-}" = "--mainnet" ]; then
  SOURCE=.env.mainnet.example
  NEXT="DOMAIN, ACME_EMAIL, RPC_URL, RPC_BACKUP_URL, MASTER_WALLET_PUBKEY, ALERT_TELEGRAM_*"
fi

TARGET=.env
if [ -e "$TARGET" ]; then
  echo "deploy/$TARGET sudah ada — tidak ditimpa. Hapus dulu bila memang ingin membuat ulang"
  echo "(PERINGATAN: password database lama tidak bisa dipulihkan dari file baru)."
  exit 1
fi

# 32 byte acak → 64 karakter hex (aman di URL database, tanpa karakter khusus).
rand() { od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }

umask 077
cp "$SOURCE" "$TARGET.tmp"
while grep -q '__GENERATE__' "$TARGET.tmp"; do
  # Tiap placeholder mendapat nilai BERBEDA (token signer wajib berbeda satu sama lain).
  sed -i "0,/__GENERATE__/s//$(rand)/" "$TARGET.tmp"
done
mv "$TARGET.tmp" "$TARGET"
chmod 600 "$TARGET"
echo "deploy/$TARGET dibuat dari $SOURCE (chmod 600). Sekarang edit $NEXT:"
echo "  nano deploy/$TARGET"
