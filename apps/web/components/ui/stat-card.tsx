import type { Stat } from "@liftoff/shared";
import type { ReactNode } from "react";
import { clusterCopy } from "@/lib/cluster";
import { formatPrice, formatStatValue, formatUsd, getCluster } from "@/lib/format";
import { MockBadge, STATUS_DEFINITIONS, StatusBadge } from "./badges";
import { cn } from "./primitives";
import { RelativeTime } from "./time";
import { Tooltip } from "./tooltip";

/** Setara USD dari harga SOL/USD berjalan tidak pernah tampil seolah angka pasti. */
const approx = (stat: Stat) =>
  stat.source === "price_feed" && Number(stat.value) !== 0 ? "≈ " : "";

/** Tampil dalam USD; saat harga pair tidak terverifikasi kembali ke angka on-chain dalam quote. */
export function usdOrQuote(usd: Stat, quote: Stat) {
  return usd.value !== null && usd.status !== "unavailable"
    ? { stat: usd, format: formatPrice }
    : { stat: quote };
}

/** Nilai stat + MOCK badge, tanpa kartu. Dipakai di tabel & kartu kecil. */
export function StatValue({
  stat,
  format,
  className,
  showMock = true,
}: {
  stat: Stat;
  format?: (value: string) => string;
  className?: string;
  showMock?: boolean;
}) {
  if (stat.value === null || stat.status === "unavailable") {
    return <span className={cn("text-text-subtle", className)}>n/a</span>;
  }
  const text = format ? format(stat.value) : formatStatValue(stat.value, stat.unit);
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span className="num">
        {approx(stat)}
        {text}
      </span>
      {showMock && stat.source === "mock" && <MockBadge />}
    </span>
  );
}

/**
 * Kartu statistik dengan status (verified/estimated/delayed/unavailable),
 * waktu update, dan tooltip definisi (Aturan #3 & #4).
 */
export function StatCard({
  label,
  stat,
  definition,
  format,
  footer,
  className,
}: {
  label: string;
  stat: Stat;
  definition: string;
  format?: (value: string) => string;
  footer?: ReactNode;
  className?: string;
}) {
  const unavailable = stat.value === null || stat.status === "unavailable";
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-[var(--radius-card)] border border-line bg-surface p-3.5",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-text-muted">
          <span className="truncate">{label}</span>
          <Tooltip
            label={`Definition of ${label}`}
            content={
              <>
                <span className="block">{definition}</span>
                <span className="mt-1.5 block text-text-muted">
                  Status <b>{stat.status}</b>: {STATUS_DEFINITIONS[stat.status]}
                </span>
              </>
            }
          />
        </span>
        {stat.source === "mock" && <MockBadge />}
      </div>
      <div
        className={cn(
          "num truncate text-xl font-semibold sm:text-2xl",
          unavailable && "text-text-subtle",
        )}
      >
        {unavailable
          ? "n/a"
          : `${approx(stat)}${
              format ? format(stat.value ?? "") : formatStatValue(stat.value ?? "", stat.unit)
            }`}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[11px] text-text-subtle">
        <StatusBadge status={stat.status} />
        {stat.updatedAt ? (
          <span>
            Updated <RelativeTime iso={stat.updatedAt} />
          </span>
        ) : (
          <span>No updates yet</span>
        )}
      </div>
      {footer}
    </div>
  );
}

/**
 * Setara USD untuk angka on-chain dalam quote pair. Devnet tidak punya harga, jadi nilainya
 * memakai harga ASUMSI pair dan selalu tampil dengan badge MOCK. Mainnet: estimasi dari harga
 * SOL/USD terverifikasi; saat harga tidak terverifikasi komponen ini tidak menampilkan apa pun.
 */
export function UsdEstimate({ stat, className }: { stat: Stat; className?: string }) {
  if (stat.value === null || stat.status === "unavailable") return null;
  return (
    <span
      className={cn("inline-flex items-center gap-1 text-xs text-text-subtle", className)}
      title={clusterCopy(getCluster()).usdEstimateTitle}
    >
      <span className="num">≈ {formatUsd(stat.value)}</span>
      {stat.source === "mock" && <MockBadge />}
    </span>
  );
}
