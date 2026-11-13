/**
 * Data economic engine untuk website (Tahap 7, Spec §16 Section 2–3, Rule 8/9): claim creator fee
 * + rekonsiliasi, buyback, burn — semua dari ledger/operasi on-chain dengan signature.
 *
 * Rule 9: fee yang baru tercatat per trade tetapi belum di-claim ditampilkan TERPISAH sebagai
 * "awaiting claim" (status `delayed`), tidak pernah sebagai dana diterima. Hasil rekonsiliasi
 * `estimated` ditandai `estimated`.
 */
import { buybackBudgets, reserveBalances, type Db, type EconomicOp } from "@liftoff/db";
import {
  CURVE_TARGET,
  ECONOMIC_CONFIG,
  pairForMint,
  parsePerQuoteEnv,
  perQuote,
  type BuybackView,
  type FeeClaimView,
  type SolanaCluster,
  type Stat,
  type TokenEconomics,
} from "@liftoff/shared";
import { assetInfo, formatUnits, indexerStat } from "./tokens";

/** Threshold buyback sama dengan worker (override env uji lokal ikut terbaca dari .env yang sama). */
const MIN_BUYBACK = parsePerQuoteEnv(process.env.BUYBACK_MIN_RAW, ECONOMIC_CONFIG.minBuybackRaw);

function asset(cluster: SolanaCluster, mint: string, tickers: Map<string, string>) {
  const info = assetInfo(cluster, mint);
  // Asset = token itu sendiri (fee CPMM berdenominasi token): pakai ticker-nya.
  return pairForMint(cluster, mint) ? info : { ...info, symbol: tickers.get(mint) ?? info.symbol };
}

const big = (d: { toFixed(n: number): string } | null | undefined) =>
  d ? BigInt(d.toFixed(0)) : 0n;

export async function loadClaimViews(
  db: Db,
  cluster: SolanaCluster,
  opts: { tokenMint?: string; limit: number },
): Promise<FeeClaimView[]> {
  let where: object = {
    kind: { in: ["claim_curve", "claim_cpmm", "fee_forward"] },
    status: "confirmed",
  };
  if (opts.tokenMint) {
    const linked = await db.$queryRaw<Array<{ claimOpId: string }>>`
      SELECT DISTINCT i."claimOpId" FROM "fee_claim_items" i
      JOIN "fee_ledger" f ON f."id" = i."feeLedgerId" WHERE f."tokenMint" = ${opts.tokenMint}
      UNION SELECT DISTINCT "claimOpId" FROM "fee_ledger"
      WHERE "tokenMint" = ${opts.tokenMint} AND "claimOpId" IS NOT NULL`;
    where = {
      ...where,
      OR: [{ tokenMint: opts.tokenMint }, { id: { in: linked.map((l) => l.claimOpId) } }],
    };
  }
  const ops = await db.economicOp.findMany({
    where,
    orderBy: { confirmedAt: "desc" },
    take: opts.limit,
    include: { reconciliations: true },
  });
  const mints = new Set<string>();
  for (const op of ops) {
    for (const r of op.reconciliations) {
      for (const t of r.tokens as Array<{ tokenMint: string }>) mints.add(t.tokenMint);
    }
  }
  const tokens = await db.token.findMany({
    where: { mint: { in: [...mints] } },
    select: { mint: true, ticker: true },
  });
  const tickers = new Map(tokens.map((t) => [t.mint!, t.ticker]));
  return ops.map((op) => {
    const recs = op.reconciliations.filter(
      (r) => r.assetMint === op.assetMint || big(r.claimedRaw) > 0n,
    );
    const status: FeeClaimView["status"] = !op.reconciliations.length
      ? "pending"
      : op.reconciliations.some((r) => r.status === "estimated")
        ? "estimated"
        : "verified";
    const a = asset(cluster, op.assetMint, tickers);
    const rows = recs.flatMap((r) =>
      (r.tokens as Array<{ tokenMint: string; ledgerRaw: string; correctionRaw: string }>)
        .filter((t) => !opts.tokenMint || t.tokenMint === opts.tokenMint)
        .map((t) => ({
          tokenMint: t.tokenMint,
          ticker: tickers.get(t.tokenMint) ?? "?",
          ledger: formatUnits(t.ledgerRaw, a.decimals),
          correction: formatUnits(t.correctionRaw, a.decimals),
        })),
    );
    return {
      id: op.id,
      kind: op.kind as FeeClaimView["kind"],
      status,
      signature: op.signature,
      claimed: formatUnits(big(op.amountOut), a.decimals),
      assetSymbol: a.symbol,
      createdAt: (op.confirmedAt ?? op.createdAt).toISOString(),
      tokens: rows,
    };
  });
}

function buybackStatus(op: EconomicOp, burn: EconomicOp | undefined): BuybackView["status"] {
  if (op.status === "failed") return "failed";
  if (op.status === "expired") return "expired";
  if (op.status !== "confirmed") return "in_progress";
  return burn?.status === "confirmed" ? "burned" : "awaiting_burn";
}

export async function loadBuybackViews(
  db: Db,
  cluster: SolanaCluster,
  opts: { tokenMint?: string; limit: number; includeFailed?: boolean },
): Promise<BuybackView[]> {
  const ops = await db.economicOp.findMany({
    where: {
      kind: "buyback",
      ...(opts.tokenMint ? { tokenMint: opts.tokenMint } : {}),
      ...(opts.includeFailed ? {} : { status: { notIn: ["failed", "expired"] } }),
    },
    orderBy: { createdAt: "desc" },
    take: opts.limit,
    include: { children: { where: { kind: "burn" }, orderBy: { createdAt: "desc" } } },
  });
  const tokens = await db.token.findMany({
    where: { mint: { in: ops.map((o) => o.tokenMint!) } },
    select: { mint: true, ticker: true },
  });
  const tickers = new Map(tokens.map((t) => [t.mint!, t.ticker]));
  return ops.map((op) => {
    const burn = op.children.find((c) => c.status === "confirmed") ?? op.children[0];
    const a = asset(cluster, op.assetMint, tickers);
    const spent = (op.details as { spentRaw?: string }).spentRaw ?? big(op.amountIn).toString();
    return {
      id: op.id,
      tokenMint: op.tokenMint!,
      ticker: tickers.get(op.tokenMint!) ?? "?",
      route: (op.details as { route?: string }).route ?? "launchlab",
      status: buybackStatus(op, burn),
      spent: formatUnits(spent, a.decimals),
      assetSymbol: a.symbol,
      bought:
        op.status === "confirmed"
          ? formatUnits(big(op.amountOut), CURVE_TARGET.tokenDecimals)
          : null,
      burned:
        burn?.status === "confirmed" && (burn.details as { verified?: boolean }).verified
          ? formatUnits(big(burn.amountOut), CURVE_TARGET.tokenDecimals)
          : null,
      buybackSignature:
        op.status === "confirmed" || op.status === "submitted" ? op.signature : null,
      burnSignature: burn?.status === "confirmed" ? burn.signature : null,
      createdAt: (op.confirmedAt ?? op.createdAt).toISOString(),
      error: op.status === "failed" || op.status === "expired" ? op.lastError : null,
    };
  });
}

/** Spec §16 Section 2 untuk satu token. */
export async function buildTokenEconomics(
  db: Db,
  cluster: SolanaCluster,
  token: { mint: string; quoteMint: string; ticker: string },
): Promise<TokenEconomics> {
  const q = assetInfo(cluster, token.quoteMint);
  const [budgets, accrued, purchased, claims, buybacks] = await Promise.all([
    buybackBudgets(db, { tokenMint: token.mint }),
    db.feeLedger.aggregate({
      where: {
        tokenMint: token.mint,
        entryType: "allocated_buyback",
        source: "creator_fee",
        assetMint: token.quoteMint,
      },
      _sum: { amount: true },
    }),
    db.economicOp.aggregate({
      where: { tokenMint: token.mint, kind: "buyback", status: "confirmed" },
      _sum: { amountOut: true },
    }),
    loadClaimViews(db, cluster, { tokenMint: token.mint, limit: 20 }),
    loadBuybackViews(db, cluster, { tokenMint: token.mint, limit: 20 }),
  ]);
  const quoteBudget = budgets.find((b) => b.assetMint === token.quoteMint);
  const claimed = quoteBudget?.claimed ?? 0n;
  const corrections = await db.feeLedger.aggregate({
    where: {
      tokenMint: token.mint,
      entryType: "correction",
      bucket: "buyback",
      assetMint: token.quoteMint,
    },
    _sum: { amount: true },
  });
  // Belum di-claim = alokasi per trade + koreksi − yang sudah tercakup claim.
  const awaiting = big(accrued._sum.amount) + big(corrections._sum.amount) - claimed;
  const spent = await db.$queryRaw<Array<{ spent: string | null }>>`
    SELECT sum(coalesce(("details"->>'spentRaw')::numeric, "amountIn"))::text AS "spent"
    FROM "economic_ops" WHERE "tokenMint" = ${token.mint} AND "kind" = 'buyback' AND "status" = 'confirmed'`;
  const status = claims.some((c) => c.status === "estimated") ? "estimated" : "verified";
  const stat = (v: bigint, decimals: number, unit: string, s: Stat["status"] = "verified") =>
    indexerStat(formatUnits(v, decimals), unit, s);
  const available = quoteBudget ? quoteBudget.available : 0n;
  return {
    feesAllocated: stat(claimed, q.decimals, q.symbol, status),
    allocationAwaitingClaim: stat(awaiting > 0n ? awaiting : 0n, q.decimals, q.symbol, "delayed"),
    tokensPurchased: stat(big(purchased._sum.amountOut), CURVE_TARGET.tokenDecimals, token.ticker),
    quoteSpent: stat(BigInt(spent[0]?.spent ?? "0"), q.decimals, q.symbol),
    budgetAvailable: stat(available > 0n ? available : 0n, q.decimals, q.symbol, status),
    minBuyback: indexerStat(
      formatUnits(perQuote(MIN_BUYBACK, token.quoteMint), q.decimals),
      q.symbol,
    ),
    latestBuyback:
      buybacks.find((b) => b.status === "burned" || b.status === "awaiting_burn") ?? null,
    claims,
    buybacks,
  };
}

/** Reserve per token: sudah di-claim (diterima) vs masih menunggu claim. */
export async function reserveSplit(db: Db, tokenMint: string, quoteMint: string) {
  const rows = await reserveBalances(db, { tokenMint });
  const r = rows.find((x) => x.assetMint === quoteMint);
  return { claimed: r?.claimed ?? 0n, awaiting: r ? r.accrued - r.claimed : 0n };
}
