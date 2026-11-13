import type { Stat } from "@liftoff/shared";
import { formatNumber, formatUsd } from "@/lib/format";
import { MockBadge, StatusBadge } from "../ui/badges";
import { cn } from "../ui/primitives";

/** Progres bonding curve menuju graduation ke pool Raydium CPMM. */
export function BondingCurveProgress({
  progress,
  graduated,
  remaining,
  compact = false,
  className,
}: {
  progress: Stat;
  graduated: boolean;
  remaining?: Stat;
  compact?: boolean;
  className?: string;
}) {
  const pct = progress.value === null ? 0 : Math.min(100, Math.max(0, Number(progress.value)));
  const label = graduated ? "Graduated" : `${formatNumber(pct, 1)}%`;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {!compact && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="text-text-muted">Bonding curve progress</span>
          <span className="flex items-center gap-1.5">
            <StatusBadge status={progress.status} />
            {progress.source === "mock" && <MockBadge />}
          </span>
        </div>
      )}
      <div
        role="progressbar"
        aria-label="Bonding curve progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        className={cn(
          "w-full overflow-hidden rounded-full border border-ink/80 bg-surface-2",
          compact ? "h-2" : "h-3",
        )}
      >
        <div
          className={cn("h-full rounded-full", graduated ? "bg-reserve" : "bg-accent")}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className={cn("num", graduated ? "text-reserve" : "text-text")}>{label}</span>
        {!compact && remaining && !graduated && remaining.value !== null && (
          <span className="num text-text-subtle">
            {remaining.unit === "USD"
              ? `≈ ${formatUsd(remaining.value)}`
              : `±${formatNumber(remaining.value, 2)} ${remaining.unit}`}{" "}
            to graduation
          </span>
        )}
        {!compact && graduated && <span className="text-text-subtle">Raydium CPMM pool</span>}
      </div>
    </div>
  );
}
