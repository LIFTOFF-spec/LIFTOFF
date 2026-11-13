"use client";

import { useNow } from "@/lib/clock";
import { formatCountdown, formatDateTime, formatRelative } from "@/lib/format";

/** "5 min ago" — dirender di klien; saat SSR menampilkan waktu absolut UTC. */
export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  const now = useNow();
  return (
    <time dateTime={iso} title={formatDateTime(iso)} className={className}>
      {now === null ? formatDateTime(iso) : formatRelative(iso, now)}
    </time>
  );
}

/** Hitung mundur ke `iso`. Menampilkan `doneLabel` jika waktunya sudah lewat. */
export function Countdown({
  iso,
  doneLabel = "now",
  className,
}: {
  iso: string;
  doneLabel?: string;
  className?: string;
}) {
  const now = useNow();
  if (now === null) {
    return <span className={className}>—</span>;
  }
  const ms = Date.parse(iso) - now;
  return (
    <time dateTime={iso} title={formatDateTime(iso)} className={className}>
      {ms <= 0 ? doneLabel : formatCountdown(ms)}
    </time>
  );
}
