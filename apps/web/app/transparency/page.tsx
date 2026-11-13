import type { BuybackView, FeeLedgerEntry } from "@liftoff/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { MockBadge, Tag } from "@/components/ui/badges";
import { Card, PageContainer, SectionTitle } from "@/components/ui/primitives";
import { StatCard } from "@/components/ui/stat-card";
import { FeeSplitDiagram } from "@/components/token/fee-split-diagram";
import { TransactionHistory } from "@/components/token/transaction-history";
import { VerifiedStats } from "@/components/token/verified-stats";
import { getTransparency } from "@/lib/api";
import { clusterCopy } from "@/lib/cluster";
import {
  claimLabel,
  explorerUrl,
  formatNumber,
  formatUsd,
  getCluster,
  shortAddress,
} from "@/lib/format";

export const metadata: Metadata = { title: "Transparency" };

const ENTRY_LABELS: Record<FeeLedgerEntry["entryType"], string> = {
  received: "Received",
  allocated_buyback: "To buyback",
  allocated_reserve: "To reserve",
  allocated_treasury: "To treasury (legacy model)",
  correction: "Correction",
};

const BUYBACK_LABELS: Record<BuybackView["status"], string> = {
  burned: "Bought & burned",
  awaiting_burn: "Burn pending",
  in_progress: "In progress",
  failed: "Failed (no funds spent)",
  expired: "Expired (never landed)",
};

/**
 * Sel ledger per koin. Devnet: USD asumsi (bertanda MOCK di judul tabel). Mainnet: jumlah native yang
 * tercatat, plus setara USD saat ini bila harga terverifikasi.
 */
function ledgerAmount(usd: string | null, native: string, symbol: string, isMock: boolean) {
  if (isMock && usd !== null) return formatUsd(usd, false);
  const amount = `${formatNumber(native, 6)} ${symbol}`;
  return usd === null ? amount : `${amount} ≈ ${formatUsd(usd, false)}`;
}

export default async function TransparencyPage() {
  const res = await getTransparency();
  const data = res.data;
  const eco = data.economic;
  // Devnet: nominal USD memakai harga pair asumsi → bertanda MOCK. Mainnet: estimasi harga berjalan.
  const isMock = data.verified.feesReceivedUsd.source === "mock";
  const copy = clusterCopy(getCluster());

  return (
    <PageContainer className="flex flex-col gap-10">
      <header>
        <h1 className="display text-[1.625rem] min-[400px]:text-3xl sm:text-5xl">Transparency.</h1>
        <p className="mt-3 max-w-2xl text-text-muted">
          The fee, burn, and reserve ledger — in aggregate and per coin. Figures verified on-chain
          are kept apart from estimates. The ledger is append-only: corrections are recorded as new
          entries.
        </p>
      </header>

      <VerifiedStats verified={data.verified} />

      <section aria-labelledby="estimated-title">
        <SectionTitle id="estimated-title" aside={<Tag tone="warn">Estimated / pending</Tag>}>
          Estimated
        </SectionTitle>
        <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-3">
          <StatCard
            label="Unverified fees"
            stat={data.estimated.feesReceivedUsd}
            definition="Fees whose per-token attribution is still estimated (not yet matched on-chain)."
          />
          <StatCard
            label="Awaiting buyback"
            stat={data.estimated.buybackPendingUsd}
            definition="Buyback budget that hasn’t reached the minimum threshold, so it hasn’t run yet."
          />
          <StatCard
            label="Launch costs (master wallet)"
            stat={data.platform.launchCostPaidByMasterWalletSol}
            definition={copy.launchCostDefinition}
          />
        </div>
      </section>

      <section aria-labelledby="engine-title">
        <SectionTitle
          id="engine-title"
          aside={
            <Tag tone={eco.health.status === "ok" ? "success" : "warn"}>
              Engine{" "}
              {eco.health.status === "ok" ? "healthy" : `degraded · ${eco.health.alerts} alert(s)`}
            </Tag>
          }
        >
          Claims, buybacks & burns
        </SectionTitle>
        <p className="mb-3 max-w-2xl text-sm text-text-muted">{copy.feeIntakeIntro}</p>
        <div className="mb-4 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2">
          {eco.claimedNative.map((s) => (
            <StatCard
              key={`c-${s.unit}`}
              label={`Creator fees claimed (${s.unit})`}
              stat={s}
              definition="Total actually received by the master wallet through confirmed claim transactions."
            />
          ))}
          {eco.spentNative.map((s) => (
            <StatCard
              key={`s-${s.unit}`}
              label={`Spent on buyback & burn (${s.unit})`}
              stat={s}
              definition="Quote spent on buybacks whose tokens have a confirmed burn."
            />
          ))}
        </div>
        <h3 className="mb-2 text-sm font-semibold">Fee claims</h3>
        <TransactionHistory
          caption="Creator-fee claims"
          isMock={false}
          emptyTitle="No claims yet"
          rows={eco.claims.map((c) => ({
            key: c.id,
            type: <Tag tone="accent">{claimLabel(c.kind)}</Tag>,
            detail: (
              <span className="text-xs">
                {c.tokens.length
                  ? c.tokens.map((t, i) => (
                      <span key={t.tokenMint}>
                        {i > 0 ? ", " : ""}
                        <Link href={`/token/${t.tokenMint}`} className="hover:underline">
                          ${t.ticker}
                        </Link>{" "}
                        {Number(t.ledger) === 0 ? (
                          `${formatNumber(t.correction, 9)} (est.)`
                        ) : (
                          <>
                            {formatNumber(t.ledger, 9)}
                            {Number(t.correction) !== 0 ? ` (corr. ${t.correction})` : ""}
                          </>
                        )}
                      </span>
                    ))
                  : "Awaiting reconciliation"}
              </span>
            ),
            amount: `${formatNumber(c.claimed, 9)} ${c.assetSymbol}`,
            signature: c.signature ?? "",
            createdAt: c.createdAt,
            status: c.status === "pending" ? ("delayed" as const) : c.status,
          }))}
        />
        <h3 className="mb-2 mt-6 text-sm font-semibold">Buybacks & burns</h3>
        <TransactionHistory
          caption="Buybacks and burns"
          isMock={false}
          emptyTitle="No buybacks yet"
          rows={eco.buybacks.map((b) => ({
            key: b.id,
            type: (
              <Tag
                tone={
                  b.status === "burned"
                    ? "burn"
                    : b.status === "failed" || b.status === "expired"
                      ? "danger"
                      : "neutral"
                }
              >
                {BUYBACK_LABELS[b.status]}
              </Tag>
            ),
            detail: (
              <span className="flex flex-col text-xs">
                <span>
                  <Link href={`/token/${b.tokenMint}`} className="hover:underline">
                    ${b.ticker}
                  </Link>{" "}
                  · {b.route === "cpmm" ? "Raydium pool" : "bonding curve"} ·{" "}
                  {b.bought ? `${formatNumber(b.bought, 0)} bought` : (b.error ?? "in progress")}
                </span>
                {b.burnSignature ? (
                  <a
                    href={explorerUrl("tx", b.burnSignature)}
                    target="_blank"
                    rel="noreferrer"
                    className="num underline underline-offset-2"
                  >
                    burn {shortAddress(b.burnSignature, 6)} ↗
                  </a>
                ) : null}
              </span>
            ),
            amount: `${formatNumber(b.spent, 6)} ${b.assetSymbol}`,
            signature: b.buybackSignature ?? "",
            createdAt: b.createdAt,
            status: b.status === "burned" ? ("verified" as const) : ("delayed" as const),
          }))}
        />
      </section>

      <section aria-labelledby="split-title">
        <SectionTitle id="split-title">Creator-fee split per token</SectionTitle>
        <Card className="border-2 border-ink p-4 sm:p-5">
          <FeeSplitDiagram />
        </Card>
      </section>

      <section aria-labelledby="per-token-title">
        <SectionTitle id="per-token-title" aside={isMock ? <MockBadge /> : undefined}>
          Ledger per coin
        </SectionTitle>
        <div className="overflow-x-auto rounded-[var(--radius-card)] border-2 border-ink bg-surface">
          <table className="w-full min-w-[640px] text-sm">
            <caption className="sr-only">
              Ledger per coin{isMock ? " (sample data / MOCK)" : ""}
            </caption>
            <thead className="border-b-2 border-ink bg-surface-2 text-left text-xs text-text-muted">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-normal">
                  Coin
                </th>
                <th scope="col" className="px-3 py-2.5 text-right font-normal">
                  Creator fees received
                </th>
                <th scope="col" className="px-3 py-2.5 text-right font-normal">
                  Buyback & burn
                </th>
                <th scope="col" className="px-3 py-2.5 text-right font-normal">
                  Reserve
                </th>

                <th scope="col" className="px-3 py-2.5 text-right font-normal">
                  Supply burned
                </th>
                <th scope="col" className="px-4 py-2.5 font-normal">
                  Attribution
                </th>
              </tr>
            </thead>
            <tbody className="num divide-y divide-line">
              {data.perToken.map((row) => (
                <tr key={row.tokenMint} className="hover:bg-surface-2">
                  <td className="px-4 py-2.5 font-sans">
                    <Link href={`/token/${row.tokenMint}`} className="hover:underline">
                      ${row.ticker}
                    </Link>{" "}
                    <span className="text-xs text-text-subtle">/{row.quoteSymbol}</span>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    {ledgerAmount(
                      row.feesReceivedUsd,
                      row.feesReceivedNative,
                      row.quoteSymbol,
                      isMock,
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right text-burn">
                    {ledgerAmount(row.buybackUsd, row.buybackNative, row.quoteSymbol, isMock)}
                  </td>
                  <td className="px-3 py-2.5 text-right text-reserve">
                    {ledgerAmount(row.reserveUsd, row.reserveNative, row.quoteSymbol, isMock)}
                  </td>

                  <td className="px-3 py-2.5 text-right">
                    {formatNumber(row.burnedSupplyPct, 2)}%
                  </td>
                  <td className="px-4 py-2.5 font-sans">
                    <Tag tone={row.attribution === "verified" ? "success" : "warn"}>
                      {row.attribution}
                    </Tag>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-text-subtle">
          Each coin is funded only by its own trades. “Estimated” attribution means the latest fee
          claim hasn’t been matched per token yet.
        </p>
      </section>

      <section aria-labelledby="entries-title">
        <SectionTitle id="entries-title">Latest ledger entries</SectionTitle>
        <TransactionHistory
          caption="Latest fee ledger entries"
          isMock={false}
          rows={data.recentEntries.map((e) => ({
            key: e.id,
            type: (
              <Tag
                tone={
                  e.entryType === "allocated_buyback"
                    ? "burn"
                    : e.entryType === "allocated_reserve"
                      ? "reserve"
                      : e.entryType === "received"
                        ? "success"
                        : "neutral"
                }
              >
                {ENTRY_LABELS[e.entryType]}
              </Tag>
            ),
            detail: (
              <Link href={`/token/${e.tokenMint}`} className="hover:underline">
                ${e.ticker}
              </Link>
            ),
            amount: `${formatNumber(e.amount, 9)} ${e.assetSymbol}`,
            signature: e.sourceSignature,
            createdAt: e.createdAt,
            status: e.attribution,
          }))}
        />
      </section>
    </PageContainer>
  );
}
