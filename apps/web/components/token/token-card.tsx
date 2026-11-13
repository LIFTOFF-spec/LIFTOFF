import type { TokenSummary } from "@liftoff/shared";
import Link from "next/link";
import { creatorLabel, formatCompact, formatNumber } from "@/lib/format";
import { PairBadge, StatusBadge, Tag } from "../ui/badges";
import { StatValue, usdOrQuote } from "../ui/stat-card";
import { RelativeTime } from "../ui/time";
import { BondingCurveProgress } from "./bonding-curve-progress";
import { TokenAvatar } from "./token-avatar";

export function ChangePct({ value }: { value: string | null }) {
  if (value === null) return <span className="text-text-subtle">n/a</span>;
  const n = Number(value);
  return (
    <span className={n >= 0 ? "num text-success" : "num text-danger"}>
      {n >= 0 ? "+" : ""}
      {formatNumber(n, 1)}%
    </span>
  );
}

export function TokenCard({ token }: { token: TokenSummary }) {
  return (
    <Link
      href={`/token/${token.mint}`}
      className="group flex flex-col gap-3 rounded-[var(--radius-card)] border-2 border-ink bg-surface p-4 transition hover:-translate-y-0.5 hover:shadow-[var(--shadow-brutal)]"
    >
      <div className="flex items-start gap-3">
        <TokenAvatar ticker={token.ticker} imageUrl={token.imageUrl} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-semibold">${token.ticker}</span>
            <PairBadge symbol={token.quoteSymbol} />
          </div>
          <p className="truncate text-xs text-text-muted">
            {token.name} · {creatorLabel(token)}
            {token.verifiedCreator && (
              <span className="ml-1 text-success" title="Verified creator (linked X account)">
                ✓
              </span>
            )}
          </p>
        </div>
        {token.marketCapQuote.status === "delayed" && <StatusBadge status="delayed" />}
      </div>

      {/* Spec §15 Token Cards: market cap, volume, pair, graduation progress, burned, reserve.
          Market cap & volume dalam estimasi USD, angka on-chain quote bila harga tidak terverifikasi. */}
      <dl className="grid grid-cols-2 gap-x-2 gap-y-1.5 text-xs min-[360px]:grid-cols-4">
        <div className="min-w-0">
          <dt className="text-text-subtle">MCap</dt>
          <dd>
            <StatValue {...usdOrQuote(token.marketCapUsd, token.marketCapQuote)} />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-text-subtle">Vol 24h</dt>
          <dd>
            <StatValue {...usdOrQuote(token.volume24hUsd, token.volume24hQuote)} />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-text-subtle">Burned</dt>
          <dd>
            <StatValue
              stat={token.burnedTokens}
              showMock={false}
              format={(v) => formatCompact(v)}
            />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-text-subtle">Reserve</dt>
          <dd>
            <StatValue stat={token.reserveBalanceQuote} />
          </dd>
        </div>
      </dl>

      <BondingCurveProgress progress={token.curveProgressPct} graduated={token.graduated} compact />

      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-text-subtle">
        {token.graduated && <Tag tone="reserve">Graduated</Tag>}
        {!token.graduated && token.graduationState === "migrating" && (
          <Tag tone="warn">Migrating to Raydium</Tag>
        )}
        {token.liquidityReinforced && <Tag tone="success">Liquidity reinforced</Tag>}
        {Number(token.burnedSupplyPct.value ?? 0) > 0 && (
          <Tag tone="burn">Burned {formatNumber(token.burnedSupplyPct.value ?? 0, 2)}%</Tag>
        )}
        {token.riskLevel !== "low" && (
          <span title="The anti-copycat check found similar branding when this token launched.">
            <Tag tone="warn">
              {token.riskLevel === "high" ? "High risk (appeal approved)" : "Similar branding"}
            </Tag>
          </span>
        )}
        <span className="ml-auto">
          <RelativeTime iso={token.createdAt} />
        </span>
      </div>
    </Link>
  );
}
