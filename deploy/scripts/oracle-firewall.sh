#!/bin/sh
# Oracle Cloud (Tahap 10d): buka port HTTP/HTTPS di firewall iptables bawaan image Ubuntu Oracle.
# Image Oracle menolak semua port masuk kecuali SSH (aturan REJECT di /etc/iptables/rules.v4) dan
# Oracle menyarankan TIDAK memakai ufw di sana. Skrip ini menambah 80/tcp, 443/tcp, 443/udp
# (HTTP/3) tepat sebelum aturan REJECT, langsung aktif DAN tersimpan untuk reboot berikutnya.
# Aman dijalankan berulang kali dan aman sebelum/sesudah Docker terpasang (tidak memakai
# iptables-restore / netfilter-persistent save, yang bisa menghapus atau ikut menyimpan aturan Docker).
# Pemakaian: sudo sh deploy/scripts/oracle-firewall.sh
set -eu
[ "$(id -u)" = 0 ] || { echo "Jalankan dengan sudo: sudo sh $0"; exit 1; }
RULES=/etc/iptables/rules.v4
[ -f "$RULES" ] || { echo "$RULES tidak ada: ini bukan image Ubuntu Oracle, pakai ufw (DEPLOY.md §3)."; exit 1; }

for spec in "tcp 80" "tcp 443" "udp 443"; do
  set -- $spec
  rule="-p $1 -m state --state NEW -m $1 --dport $2 -j ACCEPT"
  # Aktif sekarang: sisipkan sebelum REJECT pertama di rantai INPUT (atau di akhir bila tidak ada).
  # shellcheck disable=SC2086
  if ! iptables -C INPUT $rule 2> /dev/null; then
    pos=$(iptables -L INPUT -n --line-numbers | awk '$2 == "REJECT" { print $1; exit }')
    # shellcheck disable=SC2086
    if [ -n "$pos" ]; then iptables -I INPUT "$pos" $rule; else iptables -A INPUT $rule; fi
  fi
  # Tersimpan untuk reboot: tulis baris yang sama sebelum REJECT pertama di rules.v4.
  if ! grep -qxF -- "-A INPUT $rule" "$RULES"; then
    if grep -q '^-A INPUT -j REJECT' "$RULES"; then
      sed -i "0,/^-A INPUT -j REJECT/s//-A INPUT $rule\n&/" "$RULES"
    else
      sed -i "0,/^COMMIT/s//-A INPUT $rule\n&/" "$RULES"
    fi
  fi
  echo "port $2/$1 terbuka"
done
echo "Selesai. Jangan lupa: port 80 & 443 juga harus dibuka di Security List Oracle (DEPLOY.md)."
