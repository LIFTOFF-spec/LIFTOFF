import { CURVE_TARGET } from "@liftoff/shared";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PairBadge, Tag } from "@/components/ui/badges";
import { Card, PageContainer } from "@/components/ui/primitives";
import { StatCard, StatValue, usdOrQuote } from "@/components/ui/stat-card";
import { Tabs } from "@/components/ui/tabs";
import { RelativeTime } from "@/components/ui/time";
import { BondingCurveProgress } from "@/components/token/bonding-curve-progress";
import { CandleChart } from "@/components/token/candle-chart";
import { FeeSplitDiagram } from "@/components/token/fee-split-diagram";
import { GraduationPanel } from "@/components/token/graduation-panel";
import { ReservePanel } from "@/components/token/reserve-panel";
import { ChangePct } from "@/components/token/token-card";
import { TokenAvatar } from "@/components/token/token-avatar";
import { TradePanel } from "@/components/token/trade-panel";
import { TransactionHistory } from "@/components/token/transaction-history";
import { getAdoption, getToken, getTokenLedger } from "@/lib/api";
import { clusterCopy } from "@/lib/cluster";
import { claimLabel, explorerUrl, formatNumber, getCluster, shortAddress } from "@/lib/format";

export async function generateMetadata({ params }: PageProps<"/token/[mint]">): Promise<Metadata> {
  const { mint } = await params;
  const res = await getToken(mint);
  return { title: res ? `$${res.data.ticker}` : "Token not found" };
}

export default async function TokenPage({ params }: PageProps<"/token/[mint]">) {
  const { mint } = await params;
  const [tokenRes, ledgerRes, adoptionRes] = await Promise.all([
    getToken(mint),
    getTokenLedger(mint),
    getAdoption(mint).catch(() => null),
  ]);
  if (!tokenRes || !ledgerRes) notFound();

  const token = tokenRes.data;
  const ledger = ledgerRes.data;
  // Angka pasar dari indexer on-chain (Tahap 6), dalam quote pair; USD = estimasi berlabel MOCK.
  const adoption = adoptionRes?.data ?? null;
  const latestBurn = ledger.burns[0] ?? null;
  const eco = ledger.economics;
  const latest = eco.latestBuyback;
  const price = usdOrQuote(token.priceUsd, token.priceQuote);
  const tradeProps =
    token.mint && token.quoteDecimals !== null
      ? {
          mint: token.mint,
          ticker: token.ticker,
          quoteSymbol: token.quoteSymbol,
          quoteMint: token.quoteMint,
          quoteDecimals: token.quoteDecimals,
          tokenDecimals: CURVE_TARGET.tokenDecimals,
          graduated: token.graduated,
        }
      : null;

  const overview = (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="Price"
          {...price}
          definition={`Spot price per token, read from the pool on-chain in ${token.quoteSymbol}. The USD figure is an estimate at the current ${token.quoteSymbol} price.`}
          footer={
            <span className="text-xs">
              24h <ChangePct value={token.priceChange24hPct.value} />
            </span>
          }
        />
        <StatCard
          label="Market cap"
          {...usdOrQuote(token.marketCapUsd, token.marketCapQuote)}
          definition={`Price × on-chain mint supply (burns already removed). The USD figure is an estimate at the current ${token.quoteSymbol} price.`}
        />
        <StatCard
          label="24h volume"
          {...usdOrQuote(token.volume24hUsd, token.volume24hQuote)}
          definition={`Trades in the last 24 hours, including trades made outside LIFTOFF, read from on-chain trade events. The USD figure is an estimate at the current ${token.quoteSymbol} price.`}
          footer={
            <span className="flex flex-wrap items-center gap-1 text-xs text-text-subtle">
              Total <StatValue {...usdOrQuote(token.volumeTotalUsd, token.volumeTotalQuote)} />
            </span>
          }
        />
        <StatCard
          label="Liquidity"
          {...usdOrQuote(token.liquidityUsd, token.liquidityQuote)}
          definition={`${
            token.graduated
              ? `${token.quoteSymbol} side of the Raydium CPMM pool reserves`
              : `${token.quoteSymbol} held in the bonding curve`
          }. The USD figure is an estimate at the current ${token.quoteSymbol} price.`}
        />
        <StatCard
          label="Holders"
          stat={token.holders}
          definition="Number of wallets with a balance > 0."
          format={(v) => formatNumber(v, 0)}
        />
        <StatCard
          label="Graduation status"
          stat={token.curveProgressPct}
          definition={
            token.graduated
              ? "Graduated: migrated from the LaunchLab bonding curve to a Raydium CPMM pool."
              : "Progress toward the LaunchLab graduation threshold."
          }
          format={(v) =>
            token.graduated
              ? "Graduated"
              : token.graduationState === "migrating"
                ? "Migrating"
                : `${formatNumber(v, 1)}% of curve`
          }
        />
      </div>
      {token.graduation && token.graduation.state !== "not_graduated" && (
        <Card className="border-2 border-ink p-4">
          <GraduationPanel graduation={token.graduation} />
        </Card>
      )}
      <Card className="p-4">
        <BondingCurveProgress
          progress={token.curveProgressPct}
          graduated={token.graduated}
          remaining={usdOrQuote(token.curveRemainingUsd, token.curveRemainingQuote).stat}
        />
      </Card>
      <Card className="p-4 text-sm">
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs text-text-subtle">Pair</dt>
            <dd className="mt-1">
              <PairBadge symbol={token.quoteSymbol} />{" "}
              <span className="num text-xs break-all text-text-muted">{token.quoteMint}</span>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-text-subtle">Mint</dt>
            <dd className="mt-1">
              {token.mint && (
                <a
                  href={explorerUrl("address", token.mint)}
                  target="_blank"
                  rel="noreferrer"
                  className="num text-xs underline decoration-line-strong underline-offset-2"
                >
                  {shortAddress(token.mint, 6)} ↗
                </a>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-text-subtle">
              {token.graduated ? "Raydium CPMM pool" : "LaunchLab bonding curve"}
            </dt>
            <dd className="mt-1">
              {token.poolAddress ? (
                <a
                  href={explorerUrl("address", token.poolAddress)}
                  target="_blank"
                  rel="noreferrer"
                  className="num text-xs underline decoration-line-strong underline-offset-2"
                >
                  {shortAddress(token.poolAddress, 6)} ↗
                </a>
              ) : (
                <span className="text-text-subtle">Not indexed yet</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-text-subtle">Launched</dt>
            <dd className="mt-1 text-text-muted">
              <RelativeTime iso={token.createdAt} /> by the LIFTOFF master wallet
            </dd>
          </div>
          <div>
            <dt className="text-xs text-text-subtle">StonkFun adoption</dt>
            <dd className="mt-1 text-text-muted">
              {adoption ? (
                <>
                  <Tag tone={adoption.state === "adopted" ? "success" : "warn"}>
                    {adoption.state}
                  </Tag>{" "}
                  {adoption.source === "devnet_emulation" ? "(devnet emulation)" : ""}
                </>
              ) : (
                <span className="text-text-subtle">unavailable</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-text-subtle">Anti-copycat at launch</dt>
            <dd className="mt-1 capitalize text-text-muted">{token.riskLevel} risk</dd>
          </div>
          <div>
            <dt className="text-xs text-text-subtle">Launched by (creator wallet)</dt>
            <dd className="mt-1 flex flex-wrap items-center gap-1.5 text-text-muted">
              <a
                className="num underline decoration-line-strong underline-offset-2"
                href={explorerUrl("address", token.creatorWallet)}
                target="_blank"
                rel="noreferrer"
              >
                {shortAddress(token.creatorWallet)} ↗
              </a>
              {token.verifiedCreator && token.creatorXHandle && (
                <Tag tone="success">Verified creator · {token.creatorXHandle}</Tag>
              )}
            </dd>
          </div>
        </dl>
        <p className="mt-4 text-text-muted">{token.description}</p>
        <div className="mt-3 flex flex-wrap gap-3 text-xs">
          {Object.entries(token.links).map(([k, v]) =>
            v ? (
              <a
                key={k}
                href={v}
                target="_blank"
                rel="noreferrer"
                className="text-text-muted underline underline-offset-2 hover:text-text"
              >
                {k[0]?.toUpperCase()}
                {k.slice(1)} ↗
              </a>
            ) : null,
          )}
        </div>
      </Card>
    </div>
  );

  const burnTab = (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 2xl:grid-cols-3">
        <StatCard
          label="Total fees allocated"
          stat={eco.feesAllocated}
          definition="80% of this token’s creator fees that the master wallet has actually claimed and reconciled on-chain."
        />
        <StatCard
          label="Tokens purchased"
          stat={eco.tokensPurchased}
          definition="Tokens bought back on this token’s own market (bonding curve, or the Raydium pool after graduation)."
        />
        <StatCard
          label="Tokens burned"
          stat={ledger.totals.burnedTokens}
          definition="Only burns confirmed on-chain are counted."
        />
        <StatCard
          label="Estimated supply reduction"
          stat={ledger.totals.burnedSupplyPct}
          definition="Tokens burned ÷ total supply, from confirmed burn transactions."
        />
        <StatCard
          label="Claimed, awaiting buyback"
          stat={eco.budgetAvailable}
          definition={`Claimed budget not spent yet. Buybacks run in batches once it reaches the minimum of ${eco.minBuyback.value ?? "?"} ${eco.minBuyback.unit}.`}
        />
        <StatCard
          label="Not yet claimed"
          stat={eco.allocationAwaitingClaim}
          definition="Buyback share of fees recorded from trades but still sitting in the creator-fee vault. Not counted as received until claimed."
        />
      </div>
      <Card className="p-4 text-sm">
        <p className="text-xs text-text-subtle">Latest buyback</p>
        {latest ? (
          <div className="mt-1 flex flex-col gap-1">
            <p>
              Bought {formatNumber(latest.bought ?? "0", 0)} {token.ticker} with{" "}
              {formatNumber(latest.spent, 6)} {latest.assetSymbol} on the{" "}
              {latest.route === "cpmm" ? "Raydium pool" : "bonding curve"}
              {latest.burned ? ", then burned all of it." : " — burn pending."}
            </p>
            <p className="num flex flex-wrap gap-x-4 text-xs">
              {latest.buybackSignature ? (
                <a
                  href={explorerUrl("tx", latest.buybackSignature)}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2"
                >
                  Buy {shortAddress(latest.buybackSignature, 6)} ↗
                </a>
              ) : null}
              {latest.burnSignature ? (
                <a
                  href={explorerUrl("tx", latest.burnSignature)}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2"
                >
                  Burn {shortAddress(latest.burnSignature, 6)} ↗
                </a>
              ) : null}
            </p>
          </div>
        ) : latestBurn ? (
          <a
            href={explorerUrl("tx", latestBurn.buybackSignature)}
            target="_blank"
            rel="noreferrer"
            className="num mt-1 inline-block underline underline-offset-2"
          >
            {shortAddress(latestBurn.buybackSignature, 8)} ↗
          </a>
        ) : (
          <p className="mt-1 text-text-muted">
            None yet. Buybacks run in batches once the claimed budget passes the minimum size.
          </p>
        )}
      </Card>
      {eco.claims.length > 0 ? (
        <div>
          <h3 className="mb-3 text-sm font-semibold">Creator-fee claims</h3>
          <TransactionHistory
            caption={`${token.ticker} creator-fee claims`}
            isMock={false}
            rows={eco.claims.map((c) => {
              const mine = c.tokens.find((t) => t.tokenMint === token.mint);
              return {
                key: c.id,
                type: <Tag tone="accent">{claimLabel(c.kind)}</Tag>,
                detail:
                  c.kind === "fee_forward"
                    ? `Forwarded by StonkFun: ${formatNumber(c.claimed, 9)} ${c.assetSymbol} total, this token's share estimated from its trading volume`
                    : c.kind === "claim_curve"
                      ? `Shared vault claim: ${formatNumber(c.claimed, 9)} ${c.assetSymbol} total`
                      : "Raydium pool creator fee",
                amount: `${formatNumber(
                  mine && Number(mine.ledger) === 0 ? mine.correction : (mine?.ledger ?? c.claimed),
                  9,
                )} ${c.assetSymbol}`,
                signature: c.signature ?? "",
                createdAt: c.createdAt,
                status: c.status === "pending" ? ("delayed" as const) : c.status,
              };
            })}
          />
        </div>
      ) : null}
      <Card className="border-2 border-ink p-4 sm:p-5">
        <h3 className="mb-4 text-sm font-semibold">Creator-fee split</h3>
        <FeeSplitDiagram />
      </Card>
      <div>
        <h3 className="mb-3 text-sm font-semibold">Burn history</h3>
        <TransactionHistory
          caption={`${token.ticker} burn history`}
          isMock={false}
          emptyTitle="No burns yet"
          rows={ledger.burns.map((b) => ({
            key: b.id,
            type: <Tag tone="burn">Burn</Tag>,
            detail: `Bought with ${formatNumber(b.amountSpent, 4)} ${b.assetSymbol}, then burned`,
            amount: `${formatNumber(b.amountBurned, 0)} ${token.ticker}`,
            signature: b.burnSignature,
            createdAt: b.createdAt,
            status: "verified",
          }))}
        />
      </div>
    </div>
  );

  const tradesAreMock = token.recentTrades.some((t) => t.status !== "verified");
  const feeRows = ledger.fees
    .filter((f) => f.entryType === "received")
    .map((f) => ({
      key: `fee-${f.id}`,
      type: <Tag tone="accent">Creator fee</Tag>,
      detail: <span className="text-xs">To master wallet → 80/20</span>,
      amount: `${formatNumber(f.amount, 9)} ${f.assetSymbol}`,
      signature: f.sourceSignature,
      createdAt: f.createdAt,
      status: f.attribution === "verified" ? ("verified" as const) : ("estimated" as const),
    }));
  const txTab = (
    <TransactionHistory
      caption={`${token.ticker} transactions`}
      isMock={tradesAreMock}
      rows={[
        ...feeRows,
        ...token.recentTrades.map((t) => ({
          key: t.signature,
          type: (
            <Tag tone={t.side === "buy" ? "success" : "danger"}>
              {t.side === "buy" ? "Buy" : "Sell"}
            </Tag>
          ),
          detail: <span className="num text-xs">{shortAddress(t.wallet)}</span>,
          amount: (
            <span className="flex flex-col items-end">
              <span>
                {formatNumber(t.amountToken, 0)} {token.ticker}
              </span>
              <span className="text-xs text-text-subtle">
                {formatNumber(t.amountQuote, 4)} {t.quoteSymbol}
              </span>
            </span>
          ),
          signature: t.signature,
          createdAt: t.createdAt,
          status: t.status,
        })),
      ].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))}
    />
  );

  return (
    <PageContainer>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <TokenAvatar ticker={token.ticker} imageUrl={token.imageUrl} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="display text-3xl sm:text-4xl">${token.ticker}</h1>
            <PairBadge symbol={token.quoteSymbol} />
            {token.graduated ? <Tag tone="reserve">Graduated</Tag> : <Tag>Bonding curve</Tag>}
            {token.liquidityReinforced && <Tag tone="success">Liquidity reinforced</Tag>}
          </div>
          <p className="truncate text-sm text-text-muted">{token.name}</p>
        </div>
        <div className="sm:text-right">
          <p className="text-2xl font-semibold">
            <StatValue {...price} />
          </p>
          <p className="flex items-center gap-2 text-xs sm:justify-end">
            <span>
              <ChangePct value={token.priceChange24hPct.value} />{" "}
              <span className="text-text-subtle">24h</span>
            </span>
          </p>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-6">
          {token.mint && (
            <div className="rounded-[var(--radius-card)] border-2 border-ink bg-ink p-4">
              <CandleChart
                mint={token.mint}
                unit={token.quoteSymbol}
                supply={
                  // Market cap ÷ harga = supply on-chain saat ini (burn sudah dikurangi).
                  Number(token.marketCapQuote.value) / Number(token.priceQuote.value) ||
                  Number(token.totalSupply)
                }
              />
            </div>
          )}
          <p className="text-xs text-text-subtle">
            Data sources: <Tag tone="success">verified</Tag> = read on-chain by the LIFTOFF indexer
            (trades, including ones made outside LIFTOFF, pool state, holders) and updated within
            the last few minutes; <Tag tone="warn">delayed</Tag> = the indexer is behind, so the
            number may be stale; {clusterCopy(getCluster()).tokenDataSourcesTail}
          </p>
          <div className="lg:hidden">{tradeProps && <TradePanel {...tradeProps} />}</div>
          <Tabs
            items={[
              { id: "overview", label: "1 · Market overview", content: overview },
              { id: "burn", label: "2 · Buyback & burn", content: burnTab },
              {
                id: "reserve",
                label: "3 · Conviction Reserve",
                content: (
                  <ReservePanel
                    state={ledger.reserveState}
                    entries={ledger.reserve}
                    ticker={token.ticker}
                    graduated={token.graduated}
                  />
                ),
              },
              { id: "tx", label: "4 · Transactions", content: txTab },
            ]}
          />
        </div>
        <aside className="hidden lg:block" aria-label="5 · Trading">
          <div className="sticky top-20 flex flex-col gap-2">
            <p className="text-xs font-semibold text-text-subtle">5 · Trading</p>
            {tradeProps && <TradePanel {...tradeProps} />}
          </div>
        </aside>
      </div>
    </PageContainer>
  );
}
