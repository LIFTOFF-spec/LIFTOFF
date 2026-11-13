import type { SolanaCluster, StatStatus } from "@liftoff/shared";
import type { ReactNode } from "react";
import { cn } from "./primitives";
import { clusterLabel } from "@/lib/cluster";

/** Label wajib untuk setiap angka dari data contoh (Aturan #3). */
export function MockBadge({ className }: { className?: string }) {
  return (
    <span
      title="Sample (mock) data, not on-chain data"
      className={cn(
        "inline-flex items-center rounded border border-mock/60 bg-surface px-1 py-px font-mono text-[10px] font-semibold leading-none tracking-wider text-mock",
        className,
      )}
    >
      MOCK
    </span>
  );
}

/** Label cluster (DEVNET / MAINNET BETA), selalu terlihat di navbar (Tahap 11a). */
export function ClusterBadge({
  cluster,
  className,
}: {
  cluster: SolanaCluster;
  className?: string;
}) {
  const l = clusterLabel(cluster);
  return (
    <span
      title={l.title}
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-none tracking-wider",
        l.tone === "beta"
          ? "border-danger/60 bg-danger/10 text-danger"
          : "border-mock/60 bg-surface text-mock",
        className,
      )}
    >
      {l.badge}
    </span>
  );
}

const STATUS_STYLE: Record<StatStatus, { dot: string; text: string; label: string }> = {
  verified: { dot: "bg-status-verified", text: "text-status-verified", label: "verified" },
  estimated: { dot: "bg-status-estimated", text: "text-status-estimated", label: "estimated" },
  delayed: { dot: "bg-status-delayed", text: "text-status-delayed", label: "delayed" },
  unavailable: { dot: "bg-status-unavailable", text: "text-text-subtle", label: "unavailable" },
};

export const STATUS_DEFINITIONS: Record<StatStatus, string> = {
  verified: "Verified on-chain, with a transaction you can check in the explorer.",
  estimated: "Estimated by the indexer or a calculation, not yet matched against on-chain data.",
  delayed: "Data is behind its normal update schedule.",
  unavailable: "Data is not available yet.",
};

/** Status verified / estimated / delayed / unavailable (Aturan #4). */
export function StatusBadge({ status, className }: { status: StatStatus; className?: string }) {
  const s = STATUS_STYLE[status];
  return (
    <span
      title={STATUS_DEFINITIONS[status]}
      className={cn("inline-flex items-center gap-1 text-[11px] leading-none", s.text, className)}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", s.dot)} />
      {s.label}
    </span>
  );
}

export function PairBadge({ symbol, className }: { symbol: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-ink/80 bg-surface px-1.5 py-0.5 font-mono text-[11px] text-text",
        className,
      )}
    >
      /{symbol}
    </span>
  );
}

/** Label kecil netral, mis. "graduated", "paused". */
export function Tag({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "success" | "burn" | "reserve" | "warn" | "danger";
  className?: string;
}) {
  const tones = {
    neutral: "border-line-strong text-text-muted",
    accent: "border-accent-strong/40 bg-accent/10 text-accent-strong",
    success: "border-success/40 bg-success/5 text-success",
    burn: "border-burn/40 bg-burn/5 text-burn",
    reserve: "border-reserve/40 bg-reserve/5 text-reserve",
    warn: "border-warn/40 bg-warn/5 text-warn",
    danger: "border-danger/40 bg-danger/5 text-danger",
  } as const;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[11px] leading-none",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
