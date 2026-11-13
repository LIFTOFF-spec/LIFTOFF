#!/bin/sh
# Firewall server MAINNET di belakang Cloudflare (Tahap 11a), memakai ufw.
#
#   sudo sh scripts/cloudflare-firewall.sh            pasang / perbarui (aman diulang)
#   sudo sh scripts/cloudflare-firewall.sh --remove   kembali ke 80/443 terbuka untuk semua
#
# Hasil:
#   - SSH (22/tcp) boleh dari mana saja.
#   - 80/tcp, 443/tcp, 443/udp HANYA dari rentang IP resmi Cloudflare (caddy/edge/cloudflare-ips.txt;
#     perbarui dulu dengan scripts/update-cloudflare-ips.sh).
#   - Semua port masuk lain ditolak.
# PENTING: port yang dipublikasikan Docker (Caddy 80/443) TIDAK melewati aturan ufw biasa. Karena
# itu skrip ini juga menulis aturan rantai DOCKER-USER di /etc/ufw/after.rules (di antara penanda
# LIFTOFF-CLOUDFLARE) sehingga koneksi langsung ke IP server ditolak sebelum sampai ke Caddy.
# Jangan dipakai di image Ubuntu Oracle (pakai oracle-firewall.sh; DEPLOY.md §2a).
set -eu
[ "$(id -u)" = 0 ] || { echo "Jalankan dengan sudo: sudo sh $0"; exit 1; }
command -v ufw > /dev/null || { echo "ufw belum terpasang: apt -y install ufw"; exit 1; }
cd "$(dirname "$0")/.."
LIST=caddy/edge/cloudflare-ips.txt
AFTER=/etc/ufw/after.rules
BEGIN="# BEGIN LIFTOFF-CLOUDFLARE"
END="# END LIFTOFF-CLOUDFLARE"

# Hapus blok lama (bila ada) dari after.rules.
strip_block() {
  [ -f "$AFTER" ] || return 0
  sed -i "/^$BEGIN\$/,/^$END\$/d" "$AFTER"
}

# Hapus aturan ufw 80/443 yang pernah dibuat (terbuka untuk semua ATAU per rentang Cloudflare).
delete_web_rules() {
  ufw status numbered | grep -E ' (80/tcp|443/tcp|443/udp|80,443/tcp)( \(v6\))? ' \
    | sed -E 's/^\[ *([0-9]+)\].*/\1/' | sort -rn | while read -r n; do
      ufw --force delete "$n" > /dev/null
    done
}

if [ "${1:-}" = "--remove" ]; then
  strip_block
  delete_web_rules
  ufw allow 80/tcp > /dev/null && ufw allow 443/tcp > /dev/null && ufw allow 443/udp > /dev/null
  ufw reload > /dev/null
  echo "Mode Cloudflare dilepas: 80/443 terbuka untuk semua, SSH tetap terbuka."
  exit 0
fi

[ -f "$LIST" ] || { echo "$LIST tidak ada (jalankan scripts/update-cloudflare-ips.sh)"; exit 1; }
ranges=$(grep -vE '^\s*(#|$)' "$LIST")
v4=$(echo "$ranges" | grep -v ':' || true)
v6=$(echo "$ranges" | grep ':' || true)
[ "$(echo "$v4" | grep -c .)" -ge 5 ] || { echo "Daftar IPv4 Cloudflare terlalu pendek; batal."; exit 1; }
iface=$(ip route show default 2> /dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }')
[ -n "$iface" ] || { echo "Antarmuka jaringan utama tidak ditemukan (ip route show default)."; exit 1; }

# 1) ufw: kebijakan dasar + SSH dari mana saja (dulu, agar sesi SSH ini tidak terputus).
ufw default deny incoming > /dev/null
ufw default allow outgoing > /dev/null
ufw allow OpenSSH > /dev/null 2>&1 || ufw allow 22/tcp > /dev/null

# 2) ufw: 80/443 hanya dari Cloudflare (berlaku untuk lalu lintas yang tidak lewat NAT Docker,
#    termasuk IPv6). Aturan lama dibuang dulu supaya rentang yang dihapus Cloudflare ikut hilang.
delete_web_rules
for cidr in $v4 $v6; do
  ufw allow proto tcp from "$cidr" to any port 80,443 comment cloudflare > /dev/null
  ufw allow proto udp from "$cidr" to any port 443 comment cloudflare > /dev/null
done

# 3) DOCKER-USER: lalu lintas IPv4 ke container (Caddy) lewat NAT Docker.
strip_block
{
  echo "$BEGIN"
  echo "# Dibuat oleh deploy/scripts/cloudflare-firewall.sh, jangan edit manual (ASCII saja: ufw)."
  echo "*filter"
  echo ":DOCKER-USER - [0:0]"
  echo "-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN"
  for cidr in $v4; do
    echo "-A DOCKER-USER -i $iface -s $cidr -p tcp -m multiport --dports 80,443 -j RETURN"
    echo "-A DOCKER-USER -i $iface -s $cidr -p udp --dport 443 -j RETURN"
  done
  echo "-A DOCKER-USER -i $iface -p tcp -m multiport --dports 80,443 -j DROP"
  echo "-A DOCKER-USER -i $iface -p udp --dport 443 -j DROP"
  echo "-A DOCKER-USER -j RETURN"
  echo "COMMIT"
  echo "$END"
} >> "$AFTER"

ufw --force enable > /dev/null
ufw reload > /dev/null
echo "OK: SSH terbuka; 80/443 hanya dari $(echo "$ranges" | grep -c .) rentang Cloudflare (antarmuka $iface)."
echo "Cek: sudo ufw status  dan  sudo iptables -L DOCKER-USER -n"
echo "Bila Docker baru dipasang/di-restart sesudah ini, jalankan ulang skrip ini."
