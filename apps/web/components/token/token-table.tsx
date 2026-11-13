import type { TokenSummary } from "@liftoff/shared";
import Link from "next/link";
import { PairBadge } from "../ui/badges";
import { StatValue, usdOrQuote } from "../ui/stat-card";
import { BondingCurveProgress } from "./bonding-curve-progress";
import { ChangePct } from "./token-card";
import { TokenAvatar } from "./token-avatar";

/** Tabel discovery. Di layar sempit tabel bisa digeser horizontal di dalam wadahnya. */
export function TokenTable({ tokens }: { tokens: TokenSummary[] }) {
  return (
    <div className="overflow-x-auto rounded-[var(--radius-card)] border-2 border-ink bg-surface">
      <table className="w-full min-w-[720px] text-sm">
        <caption className="sr-only">
          Token list. Market cap, volume and reserve are in each token’s pair currency, read
          on-chain by the LIFTOFF indexer.
        </caption>
        <thead className="border-b-2 border-ink bg-surface-2 text-left text-xs text-text-muted">
          <tr>
            <th scope="col" className="px-4 py-3 font-normal">
              Token
            </th>
            <th scope="col" className="px-3 py-3 text-right font-normal">
              MCap
            </th>
            <th scope="col" className="px-3 py-3 text-right font-normal">
              Vol 24h
            </th>
            <th scope="col" className="px-3 py-3 text-right font-normal">
              24h
            </th>
            <th scope="col" className="px-3 py-3 font-normal">
              Curve
            </th>
            <th scope="col" className="px-3 py-3 text-right font-normal">
              Burned
            </th>
            <th scope="col" className="px-4 py-3 text-right font-normal">
              Reserve
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {tokens.map((t) => (
            <tr key={t.id} className="transition hover:bg-surface-2">
              <td className="px-4 py-3">
                <Link href={`/token/${t.mint}`} className="flex items-center gap-3">
                  <TokenAvatar ticker={t.ticker} imageUrl={t.imageUrl} size="sm" />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 font-semibold">
                      ${t.ticker} <PairBadge symbol={t.quoteSymbol} />
                    </span>
                    <span className="block truncate text-xs text-text-subtle">{t.name}</span>
                  </span>
                </Link>
              </td>
              <td className="px-3 py-3 text-right">
                <StatValue {...usdOrQuote(t.marketCapUsd, t.marketCapQuote)} />
              </td>
              <td className="px-3 py-3 text-right">
                <StatValue {...usdOrQuote(t.volume24hUsd, t.volume24hQuote)} />
              </td>
              <td className="px-3 py-3 text-right">
                <ChangePct value={t.priceChange24hPct.value} />
              </td>
              <td className="w-36 px-3 py-3">
                <BondingCurveProgress
                  progress={t.curveProgressPct}
                  graduated={t.graduated}
                  compact
                />
              </td>
              <td className="px-3 py-3 text-right">
                <StatValue stat={t.burnedSupplyPct} showMock={false} />
              </td>
              <td className="px-4 py-3 text-right">
                <StatValue stat={t.reserveBalanceQuote} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
