/**
 * View Conviction Reserve (Tahap 8, Spec §11 Phase 5, §16 Section 3): kustodi per token, keputusan
 * monitoring terakhir, dan riwayat deployment — semuanya dari ledger/tabel append-only yang diisi
 * worker reserve setelah transaksi terkonfirmasi on-chain.
 */
import { reserveCustody, type Db, type ReserveDeployment } from "@liftoff/db";
import {
  CURVE_TARGET,
  RESERVE_CONFIG,
  type ReserveCustodyView,
  type ReserveDecisionView,
  type ReserveDeploymentView,
  type ReserveOverview,
  type SolanaCluster,
  type UsdRates,
} from "@liftoff/shared";
import { reserveVaultAddresses } from "@liftoff/solana/reserve";
import { usdStat } from "./market-placeholder";
import { assetInfo, formatUnits, indexerStat } from "./tokens";

export const CUSTODY_TRUST_NOTE =
  "MVP custody: a separate SPL token account per token, derived from the token mint and controlled by the LIFTOFF signer. Only allowlisted operations into this token's own pool can use it. This is weaker than an on-chain vault program: the master key could technically move these funds outside the signer.";

const quoteOf = assetInfo;

export async function loadDeploymentViews(
  db: Db,
  cluster: SolanaCluster,
  opts: { tokenMint?: string; limit?: number } = {},
): Promise<ReserveDeploymentView[]> {
  const rows: ReserveDeployment[] = await db.reserveDeployment.findMany({
    where: opts.tokenMint ? { tokenMint: opts.tokenMint } : {},
    orderBy: { createdAt: "desc" },
    take: opts.limit ?? 50,
  });
  const tokens = await db.token.findMany({
    where: { mint: { in: [...new Set(rows.map((r) => r.tokenMint))] } },
    select: { mint: true, name: true, ticker: true },
  });
  const byMint = new Map(tokens.map((t) => [t.mint!, t]));
  return rows.map((r) => {
    const q = quoteOf(cluster, r.quoteMint);
    const u = (d: { toFixed(n: number): string }, decimals = q.decimals) =>
      formatUnits(d.toFixed(0), decimals);
    return {
      id: r.id,
      tokenName: byMint.get(r.tokenMint)?.name ?? "?",
      ticker: byMint.get(r.tokenMint)?.ticker ?? "?",
      tokenMint: r.tokenMint,
      quoteSymbol: q.symbol,
      reserveBefore: u(r.reserveBeforeRaw),
      amountDeployed: u(r.quoteDeployedRaw),
      swapIn: u(r.swapInRaw),
      quoteAdded: u(r.quoteAddedRaw),
      tokenAdded: u(r.tokenAddedRaw, CURVE_TARGET.tokenDecimals),
      pool: r.pool,
      lpMint: r.lpMint,
      lpBurned: r.lpBurnedRaw.toFixed(0),
      signature: r.signature,
      lock: { method: "burn", verified: r.lockVerified, proofSignature: r.signature },
      remainingReserve: u(r.remainingReserveRaw),
      createdAt: r.createdAt.toISOString(),
    };
  });
}

/** Kustodi, keputusan terakhir, dan deployment satu token. */
export async function loadTokenReserveExtras(
  db: Db,
  cluster: SolanaCluster,
  rates: UsdRates,
  master: string,
  token: { mint: string; quoteMint: string },
): Promise<{
  custody: ReserveCustodyView | null;
  latestDecision: ReserveDecisionView | null;
  deployments: ReserveDeploymentView[];
}> {
  const q = quoteOf(cluster, token.quoteMint);
  const [[pos], vault, decision, deployments, residual] = await Promise.all([
    reserveCustody(db, { tokenMint: token.mint }),
    db.reserveVault.findUnique({ where: { tokenMint: token.mint } }),
    db.reserveDecision.findFirst({
      where: { tokenMint: token.mint },
      orderBy: { createdAt: "desc" },
    }),
    loadDeploymentViews(db, cluster, { tokenMint: token.mint, limit: 20 }),
    db.reserveDeployment.aggregate({
      where: { tokenMint: token.mint },
      _sum: { tokenResidualRaw: true },
    }),
  ]);
  const addr = vault ?? reserveVaultAddresses(master, token.mint);
  const position = pos?.assetMint === token.quoteMint ? pos : undefined;
  const custody: ReserveCustodyView = {
    kind: "segregated_custody",
    quoteAccount: addr.quoteAccount,
    tokenAccount: addr.tokenAccount,
    inCustody: indexerStat(formatUnits(position?.inVault ?? 0n, q.decimals), q.symbol),
    inMasterAccount: indexerStat(formatUnits(position?.inMaster ?? 0n, q.decimals), q.symbol),
    tokenResidual: indexerStat(
      formatUnits(residual._sum.tokenResidualRaw?.toFixed(0) ?? "0", CURVE_TARGET.tokenDecimals),
      "tokens",
    ),
    trustNote: CUSTODY_TRUST_NOTE,
  };
  let latestDecision: ReserveDecisionView | null = null;
  if (decision) {
    const s = (decision.inputSnapshot ?? {}) as {
      poolQuoteRaw?: string | null;
      poolLiquidityUsd?: number | null;
      depth2PctQuoteRaw?: string | null;
      simulatedPriceImpactBps?: number;
      volumeChangeBps?: number | null;
      oneHourMoveBps?: number;
      failedSafetyChecks?: string[];
    };
    const native = (v: string | null | undefined) =>
      indexerStat(v ? formatUnits(v, q.decimals) : null, q.symbol, "verified", decision.createdAt);
    latestDecision = {
      at: decision.createdAt.toISOString(),
      allowed: decision.allowed,
      reasons: decision.reasons,
      failedSafetyChecks: s.failedSafetyChecks ?? [],
      poolLiquidity: native(s.poolQuoteRaw),
      // Mainnet: dari harga saat ini, bukan angka lama di snapshot keputusan.
      poolLiquidityUsd: usdStat(
        rates,
        rates.kind === "live"
          ? Number(formatUnits(s.poolQuoteRaw ?? "0", q.decimals)) * rates.rateFor(token.quoteMint)
          : (s.poolLiquidityUsd ?? 0),
        "estimated",
      ),
      depth2Pct: native(s.depth2PctQuoteRaw),
      priceImpactBps: s.simulatedPriceImpactBps ?? 0,
      volumeChangeBps: s.volumeChangeBps ?? null,
      oneHourMoveBps: s.oneHourMoveBps ?? 0,
    };
  }
  return { custody, latestDecision, deployments };
}

export async function reserveOverview(
  db: Db,
  cluster: SolanaCluster,
  rates: UsdRates,
): Promise<ReserveOverview> {
  const [deployments, totals, reinforced] = await Promise.all([
    loadDeploymentViews(db, cluster, { limit: 50 }),
    db.reserveDeployment.groupBy({ by: ["quoteMint"], _sum: { quoteDeployedRaw: true } }),
    db.reserveDeployment.findMany({
      where: { lockVerified: true },
      distinct: ["tokenMint"],
      select: { tokenMint: true },
    }),
  ]);
  let usd = 0;
  const totalDeployedNative = totals.map((t) => {
    const q = quoteOf(cluster, t.quoteMint);
    const v = formatUnits(t._sum.quoteDeployedRaw?.toFixed(0) ?? "0", q.decimals);
    usd += Number(v) * rates.rateFor(t.quoteMint);
    return indexerStat(v, q.symbol);
  });
  return {
    deployments,
    tokensReinforced: reinforced.length,
    totalDeployedNative,
    totalDeployedUsd: usdStat(rates, usd, "estimated"),
    custodyKind: "segregated_custody",
    configStatus: RESERVE_CONFIG.status,
  };
}
