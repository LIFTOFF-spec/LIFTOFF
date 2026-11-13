import { BPS_DENOMINATOR, FEE_CONFIG } from "@liftoff/shared";
import type { FeeConfig } from "@liftoff/shared";
import { clusterCopy } from "@/lib/cluster";
import { bpsOf, formatBps, getCluster } from "@/lib/format";
import { Tag } from "../ui/badges";
import { cn } from "../ui/primitives";

/**
 * Diagram alokasi creator fee (Spec §9–10, Rule 2): 80% Buyback & Burn / 20% Conviction Reserve.
 * Semua angka dibaca dari FEE_CONFIG (Aturan #10); tidak ada persentase yang ditulis manual.
 * Platform fee milik StonkFun dan tidak masuk alokasi ini.
 */
export function FeeSplitDiagram({
  config = FEE_CONFIG,
  className,
}: {
  config?: FeeConfig;
  className?: string;
}) {
  const parts = [
    {
      key: "buyback",
      label: "Buyback & burn",
      bps: config.split.buybackBurn,
      bar: "bg-burn",
      text: "text-burn",
      desc: "Buys this token on the open market, then burns it permanently.",
    },
    {
      key: "reserve",
      label: "Conviction Reserve",
      bps: config.split.convictionReserve,
      bar: "bg-reserve",
      text: "text-reserve",
      desc: "Held separately for this token; can reinforce pool liquidity after graduation.",
    },
  ];

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          Creator fee <span className="num font-semibold">{formatBps(config.creatorFeeBps)}</span>{" "}
          per curve trade (
          <span className="num">{formatBps(config.expectedCpmmCreatorFeeBps)}</span> after
          graduation) → LIFTOFF master wallet
        </p>
        {config.status === "unverified" ? (
          <Tag tone="warn">Not verified yet</Tag>
        ) : (
          <Tag tone={getCluster() === "mainnet-beta" ? "warn" : "success"}>
            {clusterCopy(getCluster()).feeVerifiedTag}
          </Tag>
        )}
      </div>

      <div className="flex h-4 w-full overflow-hidden rounded-full border-2 border-ink" aria-hidden>
        {parts.map((p) => (
          <div
            key={p.key}
            className={p.bar}
            style={{ width: `${(p.bps / BPS_DENOMINATOR) * 100}%` }}
          />
        ))}
      </div>

      <ul className="grid gap-3 sm:grid-cols-2">
        {parts.map((p) => (
          <li key={p.key} className="rounded-xl border border-line bg-bg p-3">
            <p className={cn("text-xs font-semibold", p.text)}>{p.label}</p>
            <p className="num mt-1 text-lg font-semibold">{formatBps(p.bps)}</p>
            <p className="num text-[11px] text-text-subtle">
              = {formatBps(bpsOf(p.bps, config.creatorFeeBps))} of curve trade value
            </p>
            <p className="mt-2 text-xs text-text-muted">{p.desc}</p>
          </li>
        ))}
      </ul>
      <p className="text-xs text-text-subtle">
        Each token’s share comes only from that token’s own trades and is accounted separately. The{" "}
        <span className="num">{formatBps(config.platformFeeBps)}</span> platform fee belongs to the{" "}
        {clusterCopy(getCluster()).feePlatformOwner} and is not LIFTOFF revenue. No treasury share:
        each coin’s on-chain launch cost is paid by its creator; LIFTOFF’s other running costs are
        funded by its owner.
      </p>
    </div>
  );
}
