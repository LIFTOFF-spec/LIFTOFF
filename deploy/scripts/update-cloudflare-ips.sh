#!/bin/sh
# Perbarui daftar IP resmi Cloudflare (Tahap 11a) lalu tulis ulang file Caddy mode "cloudflare".
#
#   sh scripts/update-cloudflare-ips.sh            (dari folder deploy/)
#   sh scripts/update-cloudflare-ips.sh --offline  (hanya tulis ulang .caddy dari daftar yang ada)
#
# Sumber: https://www.cloudflare.com/ips-v4 dan /ips-v6 (daftar publik, jarang berubah).
# Hasil: caddy/edge/cloudflare-ips.txt, cloudflare-global.caddy, cloudflare-site.caddy.
# Sesudahnya: sh scripts/cloudflare-firewall.sh (ufw) dan restart caddy.
set -eu
cd "$(dirname "$0")/.."
EDGE=caddy/edge
LIST=$EDGE/cloudflare-ips.txt

if [ "${1:-}" != "--offline" ]; then
  tmp=$(mktemp)
  trap 'rm -f "$tmp"' EXIT
  for v in 4 6; do
    curl -fsS --max-time 20 "https://www.cloudflare.com/ips-v$v" >> "$tmp"
    printf '\n' >> "$tmp"
  done
  # Hanya baris berbentuk CIDR; tolak hasil kosong / aneh (mis. halaman error).
  grep -E '^[0-9a-fA-F:.]+/[0-9]+$' "$tmp" | sort -u > "$tmp.ok" || true
  n=$(wc -l < "$tmp.ok" | tr -d ' ')
  if [ "$n" -lt 10 ]; then
    echo "Daftar IP Cloudflare tidak valid ($n baris); file lama tidak diubah." >&2
    rm -f "$tmp.ok"
    exit 1
  fi
  {
    echo "# Rentang IP resmi Cloudflare (www.cloudflare.com/ips-v4, /ips-v6)."
    echo "# Diperbarui: $(date -u +%Y-%m-%d) oleh scripts/update-cloudflare-ips.sh. Satu CIDR per baris."
    cat "$tmp.ok"
  } > "$LIST"
  rm -f "$tmp.ok"
fi

ranges=$(grep -vE '^\s*(#|$)' "$LIST" | tr '\n' ' ' | sed 's/ $//')
[ -n "$ranges" ] || { echo "$LIST kosong" >&2; exit 1; }

cat > "$EDGE/cloudflare-global.caddy" <<CADDY
# Mode "cloudflare" (EDGE_MODE=cloudflare): semua pengunjung datang lewat proxy Cloudflare.
# DIBUAT OTOMATIS oleh scripts/update-cloudflare-ips.sh dari cloudflare-ips.txt; jangan edit manual.
# Caddy hanya memercayai header CF-Connecting-IP bila koneksi datang dari IP Cloudflare;
# {client_ip} = IP pengunjung asli dan diteruskan ke API sebagai X-Forwarded-For.
# abort (penutup koneksi non-Cloudflare di cloudflare-site.caddy) harus jalan sebelum handle.
order abort before handle

servers {
	trusted_proxies static $ranges
	client_ip_headers CF-Connecting-IP
}
CADDY

cat > "$EDGE/cloudflare-site.caddy" <<CADDY
# Mode "cloudflare": koneksi yang TIDAK berasal dari IP Cloudflare ditutup (lapisan kedua sesudah
# firewall ufw). Mencegah orang yang tahu IP server melewati Cloudflare.
# DIBUAT OTOMATIS oleh scripts/update-cloudflare-ips.sh; jangan edit manual.
@not_cloudflare not remote_ip $ranges
abort @not_cloudflare
CADDY

echo "OK: $(grep -cvE '^\s*(#|$)' "$LIST") rentang IP Cloudflare → $EDGE/cloudflare-*.caddy"
