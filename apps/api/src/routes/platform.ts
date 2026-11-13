/**
 * GET /api/activity, GET /api/transparency, GET /api/stats (Spec §17 live statistics).
 *
 * Nominal native (lamport, unit token) berasal dari ledger DB / receipt on-chain. Konversi ke USD
 * memakai harga ASUMSI pair di devnet (bertanda MOCK/estimated) dan harga SOL/USD terverifikasi saat
 * ini di mainnet (selalu estimated; tidak terverifikasi = tidak tersedia). Angka native tersedia
 * terpisah (`native`) dengan status verified/delayed. Model Spec: tidak ada treasury; creator fee → 80/20.
 */
import {
  CURVE_TARGET,
  freshness,
  pairForMint,
  type StatStatus,
  type ActivityItem,
  type PlatformStats,
  type SolPriceStatus,
  type TokenLedgerRow,
  type TransparencySummary,
} from "@liftoff/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assetInfo } from "../lib/tokens";
import { envelope, type AppContext } from "../app";
import { economicHealth } from "@liftoff/db";
import { loadBuybackViews, loadClaimViews } from "../lib/economics";
import { trimNumber, usdStat } from "../lib/market-placeholder";
import { reserveOverview } from "../lib/reserve";
import {
  feeEntryKind,
  formatUnits,
  indexerStat,
  loadAggregates,
  TOKEN_INCLUDE,
  toSummary,
} from "../lib/tokens";
import { economicHealthOptions } from "./health";

/** Biaya launch terukur di devnet (docs/poc-report.md, bagian f). */
const LAUNCH_COST_LAMPORTS = 20_617_040n;

/** Jumlah ledger per aset → Stat native (mis. "1,2 SOL"). */
function nativeTotals<G extends { assetMint: string }>(
  groups: G[],
  amount: (g: G) => bigint,
  q: (assetMint: string) => { symbol: string; decimals: number },
) {
  const sums = new Map<string, bigint>();
  for (const g of groups) sums.set(g.assetMint, (sums.get(g.assetMint) ?? 0n) + amount(g));
  return [...sums.entries()].map(([mint, sum]) => {
    const { symbol, decimals } = q(mint);
    return indexerStat(formatUnits(sum, decimals), symbol);
  });
}

export async function platformRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, config } = ctx;
  const quote = (assetMint: string) => assetInfo(config.cluster, assetMint);
  // Harga dibaca sekali per request: satu respons memakai satu harga.
  const money = () => {
    const rates = ctx.usdRates();
    return {
      rates,
      hasUsd: rates.kind !== "none",
      // Token LIFTOFF sendiri (fee CPMM) tidak punya harga USD di sini dan tidak dihitung, seperti biasa.
      // Quote tanpa harga terverifikasi membuat total `n/a` lewat NaN, bukan angka yang kurang.
      toUsd: (raw: bigint | string, assetMint: string) => {
        if (!pairForMint(config.cluster, assetMint) || BigInt(raw) === 0n) return 0;
        return Number(formatUnits(raw, quote(assetMint).decimals)) * rates.rateFor(assetMint);
      },
      usdOf: (value: number | null, status?: StatStatus) => usdStat(rates, value, status),
    };
  };

  app.get("/api/activity", async (req) => {
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(50).default(12) })
      .parse(req.query);
    const { toUsd, usdOf } = money();
    const [fees, burns, launches] = await Promise.all([
      db.feeLedger.findMany({
        where: { entryType: "received", source: "creator_fee" },
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
      db.burnLedger.findMany({ orderBy: { createdAt: "desc" }, take: limit }),
      db.transaction.findMany({
        where: { type: "create", confirmationStatus: { in: ["confirmed", "finalized"] } },
        orderBy: { createdAt: "desc" },
        take: limit,
        include: { job: { include: { token: true } } },
      }),
    ]);
    const mints = [...new Set([...fees.map((f) => f.tokenMint), ...burns.map((b) => b.tokenMint)])];
    const tickers = new Map(
      (
        await db.token.findMany({
          where: { mint: { in: mints } },
          select: { mint: true, ticker: true },
        })
      ).map((t) => [t.mint!, t.ticker]),
    );

    const items: ActivityItem[] = [
      ...fees.map((f): ActivityItem => {
        const q = quote(f.assetMint);
        return {
          id: `fee:${f.id}`,
          kind: "trade",
          ticker: tickers.get(f.tokenMint) ?? "?",
          tokenMint: f.tokenMint,
          summary: `Trade paid ${formatUnits(f.amount.toFixed(0), q.decimals)} ${q.symbol} creator fee (80% burn / 20% reserve)`,
          amountUsd: usdOf(toUsd(f.amount.toFixed(0), f.assetMint), f.attribution),
          signature: f.sourceSignature,
          createdAt: f.createdAt.toISOString(),
        };
      }),
      ...burns.map((b): ActivityItem => {
        const q = quote(b.assetMint);
        return {
          id: `burn:${b.id}`,
          kind: "burn",
          ticker: tickers.get(b.tokenMint) ?? "?",
          tokenMint: b.tokenMint,
          summary: `Bought back with ${formatUnits(b.amountSpent.toFixed(0), q.decimals)} ${q.symbol} and burned`,
          amountUsd: usdOf(toUsd(b.amountSpent.toFixed(0), b.assetMint), "verified"),
          signature: b.burnSignature,
          createdAt: b.createdAt.toISOString(),
        };
      }),
      ...launches
        .filter((l) => l.job?.token.mint)
        .map((l): ActivityItem => ({
          id: `launch:${l.signature}`,
          kind: "launch",
          ticker: l.job!.token.ticker,
          tokenMint: l.job!.token.mint!,
          summary: `$${l.job!.token.ticker} launched from the master wallet`,
          amountUsd: indexerStat(null, "USD"),
          signature: l.signature,
          createdAt: l.createdAt.toISOString(),
        })),
    ];
    items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return envelope(items.slice(0, limit));
  });

  app.get("/api/transparency", async () => {
    const { rates, toUsd, usdOf, hasUsd } = money();
    const [tokens, feeGroups, burnGroups, reserveGroups, recent] = await Promise.all([
      db.token.findMany({
        where: { launchStatus: "live", mint: { not: null } },
        include: TOKEN_INCLUDE,
      }),
      // Model Spec: hanya creator fee yang menjadi dana LIFTOFF (platform fee milik StonkFun;
      // entri platform_vault/referral lama tetap di ledger tetapi tidak dihitung di sini).
      db.feeLedger.groupBy({
        by: ["tokenMint", "assetMint", "entryType", "bucket", "attribution"],
        where: { source: "creator_fee" },
        _sum: { amount: true },
      }),
      db.burnLedger.groupBy({ by: ["tokenMint", "assetMint"], _sum: { amountSpent: true } }),
      db.reserveLedger.groupBy({
        by: ["tokenMint", "assetMint", "entryType"],
        _sum: { amount: true },
      }),
      db.feeLedger.findMany({ orderBy: { createdAt: "desc" }, take: 15 }),
    ]);
    const aggs = await loadAggregates(
      db,
      tokens.map((t) => t.mint!),
    );
    const byMint = new Map(tokens.map((t) => [t.mint!, t]));

    let verifiedFees = 0;
    let estimatedFees = 0;
    let allocatedBuyback = 0;
    const perTokenUsd = new Map<string, Record<string, number>>();
    const perTokenRaw = new Map<string, Record<string, bigint>>();
    const perTokenAsset = new Map<string, string>();
    const estimatedMints = new Set<string>();
    for (const g of feeGroups) {
      const raw = BigInt(g._sum.amount?.toFixed(0) ?? "0");
      const usd = toUsd(raw, g.assetMint);
      const type = feeEntryKind(g);
      const row = perTokenUsd.get(g.tokenMint) ?? {};
      row[type] = (row[type] ?? 0) + usd;
      perTokenUsd.set(g.tokenMint, row);
      const rawRow = perTokenRaw.get(g.tokenMint) ?? {};
      rawRow[type] = (rawRow[type] ?? 0n) + raw;
      perTokenRaw.set(g.tokenMint, rawRow);
      perTokenAsset.set(g.tokenMint, g.assetMint);
      if (g.attribution === "estimated") estimatedMints.add(g.tokenMint);
      if (type === "received") {
        if (g.attribution === "verified") verifiedFees += usd;
        else estimatedFees += usd;
      }

      if (type === "allocated_buyback") allocatedBuyback += usd;
    }
    const burnedUsd = burnGroups.reduce(
      (acc, g) => acc + toUsd(g._sum.amountSpent?.toFixed(0) ?? "0", g.assetMint),
      0,
    );
    const reserveUsd = (type: string) =>
      reserveGroups
        .filter((g) => g.entryType === type)
        .reduce((acc, g) => acc + toUsd(g._sum.amount?.toFixed(0) ?? "0", g.assetMint), 0);

    const summaries = tokens.map((t) => toSummary(t, aggs.get(t.mint!)!, config.cluster, rates));
    const perToken: TokenLedgerRow[] = [...perTokenUsd.entries()]
      .filter(([mint]) => byMint.has(mint))
      .map(([mint, row]): TokenLedgerRow => {
        const token = byMint.get(mint)!;
        const summary = summaries.find((s) => s.mint === mint);
        const rawRow = perTokenRaw.get(mint) ?? {};
        const { decimals } = quote(perTokenAsset.get(mint) ?? "");
        const native = (...types: string[]) =>
          formatUnits(
            types.reduce((acc, t) => acc + (rawRow[t] ?? 0n), 0n),
            decimals,
          );
        const usd = (value: number) => (hasUsd ? trimNumber(value) : null);
        return {
          tokenMint: mint,
          ticker: token.ticker,
          quoteSymbol: summary?.quoteSymbol ?? "?",
          attribution: estimatedMints.has(mint) ? "estimated" : "verified",
          feesReceivedUsd: usd(row.received ?? 0),
          buybackUsd: usd(row.allocated_buyback ?? 0),
          reserveUsd: usd(row.allocated_reserve ?? 0),
          feesReceivedNative: native("received"),
          buybackNative: native("allocated_buyback"),
          reserveNative: native("allocated_reserve"),
          burnedSupplyPct: summary?.burnedSupplyPct.value ?? "0",
        };
      })
      .sort((a, b) =>
        hasUsd
          ? Number(b.feesReceivedUsd) - Number(a.feesReceivedUsd)
          : Number(b.feesReceivedNative) - Number(a.feesReceivedNative),
      );

    const tickers = new Map(tokens.map((t) => [t.mint!, t.ticker]));
    const recentEntries: TransparencySummary["recentEntries"] = recent.map((f) => {
      const q = quote(f.assetMint);
      return {
        id: f.id,
        sourceSignature: f.sourceSignature,
        tokenMint: f.tokenMint,
        amount: formatUnits(f.amount.toFixed(0), q.decimals),
        assetSymbol: q.symbol,
        entryType: f.entryType,
        source: f.source,
        attribution: f.attribution,
        createdAt: f.createdAt.toISOString(),
        ticker: tickers.get(f.tokenMint) ?? "?",
      };
    });

    // Economic engine (Tahap 7): claim + rekonsiliasi, buyback, burn — dengan signature.
    const [claims, buybacks, claimedGroups, spentGroups, health] = await Promise.all([
      loadClaimViews(db, config.cluster, { limit: 20 }),
      loadBuybackViews(db, config.cluster, { limit: 20, includeFailed: true }),
      db.economicOp.groupBy({
        by: ["assetMint"],
        where: { kind: { in: ["claim_curve", "claim_cpmm", "fee_forward"] }, status: "confirmed" },
        _sum: { amountOut: true },
      }),
      db.burnLedger.groupBy({
        by: ["assetMint"],
        where: { source: "buyback" },
        _sum: { amountSpent: true },
      }),
      economicHealth(db, economicHealthOptions()),
    ]);
    const nativeStats = (
      rows: Array<{
        assetMint: string;
        _sum: Record<string, { toFixed(n: number): string } | null>;
      }>,
      field: string,
    ) =>
      rows
        .filter((g) => pairForMint(config.cluster, g.assetMint))
        .map((g) => {
          const q = quote(g.assetMint);
          return indexerStat(formatUnits(g._sum[field]?.toFixed(0) ?? "0", q.decimals), q.symbol);
        });

    // Volume 24 jam dari trade terindeks (native on-chain), dikonversi dengan harga pair saat ini.
    const volume = summaries.reduce(
      (acc, s) =>
        acc +
        (s.volume24hUsd.value === null && Number(s.volume24hQuote.value ?? 0) > 0
          ? Number.NaN
          : Number(s.volume24hUsd.value ?? 0)),
      0,
    );
    const launched = BigInt(tokens.length);
    const raw = (d: { toFixed(n: number): string } | null | undefined) =>
      BigInt(d?.toFixed(0) ?? 0);
    const data: TransparencySummary = {
      verified: {
        feesReceivedUsd: usdOf(verifiedFees, "verified"),
        burnedUsd: usdOf(burnedUsd, "verified"),
        reserveContributedUsd: usdOf(reserveUsd("contribution"), "verified"),
        reserveDeployedUsd: usdOf(reserveUsd("deployment"), "verified"),
        native: {
          feesReceived: nativeTotals(
            feeGroups.filter((g) => g.attribution === "verified" && feeEntryKind(g) === "received"),
            (g) => raw(g._sum.amount),
            quote,
          ),
          burned: nativeTotals(burnGroups, (g) => raw(g._sum.amountSpent), quote),
          reserveContributed: nativeTotals(
            reserveGroups.filter((g) => g.entryType === "contribution"),
            (g) => raw(g._sum.amount),
            quote,
          ),
          reserveDeployed: nativeTotals(
            reserveGroups.filter((g) => g.entryType === "deployment"),
            (g) => raw(g._sum.amount),
            quote,
          ),
        },
      },
      estimated: {
        feesReceivedUsd: usdOf(estimatedFees, "estimated"),
        buybackPendingUsd: usdOf(Math.max(allocatedBuyback - burnedUsd, 0), "delayed"),
      },
      platform: {
        tokensLaunched: indexerStat(String(tokens.length), "token"),
        tokensGraduated: indexerStat(String(tokens.filter((t) => t.graduatedAt).length), "token"),
        volume24hUsd: usdOf(volume, "estimated"),
        // Angka devnet: di mainnet tidak ditampilkan sampai biaya nyata terukur (MAINNET_TEST).
        launchCostPaidByMasterWalletSol:
          config.cluster === "mainnet-beta"
            ? indexerStat(null, "SOL")
            : indexerStat(formatUnits(launched * LAUNCH_COST_LAMPORTS, 9), "SOL", "estimated"),
      },
      perToken,
      recentEntries,
      economic: {
        claims,
        buybacks,
        claimedNative: nativeStats(claimedGroups, "amountOut"),
        spentNative: nativeStats(spentGroups, "amountSpent"),
        health: {
          status: health.status,
          alerts: health.alerts.length,
          checkedAt: health.checkedAt,
        },
      },
    };
    return envelope(data);
  });

  // Spec §11 Phase 5: riwayat deployment Conviction Reserve semua token (bukti on-chain).
  app.get("/api/reserve", async () =>
    envelope(await reserveOverview(db, config.cluster, ctx.usdRates())),
  );

  // Status harga SOL/USD untuk website & pemeriksaan. Hanya kode alasan, tanpa pesan error mentah.
  app.get("/api/price/sol", async () => {
    const limits = config.solPrice.config;
    const base = {
      maxAgeSeconds: limits.maxAgeSeconds,
      maxDeviationBps: limits.maxDeviationBps,
    };
    if (config.cluster !== "mainnet-beta") {
      return envelope<SolPriceStatus>({
        ...base,
        status: "assumed",
        usd: null,
        observedAt: null,
        ageSeconds: null,
        deviationBps: null,
        issues: [],
      });
    }
    const p = ctx.solPrice?.current();
    return envelope<SolPriceStatus>({
      ...base,
      status: p?.status ?? "unverified",
      usd: p?.usd == null ? null : trimNumber(p.usd),
      observedAt: p?.observedAt ?? null,
      ageSeconds: p?.ageSeconds ?? null,
      deviationBps: p?.deviationBps ?? null,
      issues: p?.issues ?? ["stonkfun_unreadable", "jupiter_unreadable"],
    });
  });

  // Spec §17: statistik live homepage, hanya dari data terverifikasi (ledger & receipt on-chain).
  app.get("/api/stats", async () => {
    const { toUsd, usdOf } = money();
    const [launched, volumeGroups, burned, reserveGroups, lastIndexed] = await Promise.all([
      db.token.count({ where: { launchStatus: "live", mint: { not: null } } }),
      // Semua trade terindeks (UI LIFTOFF + di luar UI), dibaca dari event on-chain.
      db.tradeReceipt.groupBy({ by: ["quoteMint"], _sum: { amountQuote: true } }),
      db.burnLedger.aggregate({ _sum: { amountBurned: true } }),
      db.reserveLedger.groupBy({ by: ["assetMint", "entryType"], _sum: { amount: true } }),
      db.tokenMarket.aggregate({ _max: { indexedAt: true } }),
    ]);
    const indexedAt = lastIndexed._max.indexedAt;
    // Volume butuh indexer yang jalan; jika tertinggal, angka tetap tampil tetapi "delayed".
    const volumeStatus = indexedAt ? freshness(indexedAt) : "delayed";
    const native = (raw: string, assetMint: string, status: StatStatus, at: Date | null) => {
      const q = quote(assetMint);
      return indexerStat(formatUnits(raw, q.decimals), q.symbol, status, at);
    };
    const volumeUsd = volumeGroups.reduce(
      (acc, g) => acc + toUsd(g._sum.amountQuote?.toFixed(0) ?? "0", g.quoteMint),
      0,
    );
    const reserveRows = (type: string) => reserveGroups.filter((g) => g.entryType === type);
    const reserveUsd = (type: string) =>
      reserveRows(type).reduce(
        (acc, g) => acc + toUsd(g._sum.amount?.toFixed(0) ?? "0", g.assetMint),
        0,
      );
    const burnedRaw = burned._sum.amountBurned?.toFixed(0) ?? "0";
    const now = new Date();
    const data: PlatformStats = {
      tokensLaunched: indexerStat(String(launched), "token"),
      // Jumlah native on-chain terverifikasi; konversi USD = harga pair saat ini → estimated.
      tradingVolumeUsd: usdOf(volumeUsd, "estimated"),
      tokensBurned: indexerStat(formatUnits(burnedRaw, CURVE_TARGET.tokenDecimals), "tokens"),
      reserveAccumulatedUsd: usdOf(reserveUsd("contribution"), "estimated"),
      liquidityReinforcedUsd: usdOf(reserveUsd("deployment"), "estimated"),
      native: {
        tradingVolume: volumeGroups.map((g) =>
          native(g._sum.amountQuote?.toFixed(0) ?? "0", g.quoteMint, volumeStatus, indexedAt),
        ),
        reserveAccumulated: reserveRows("contribution").map((g) =>
          native(g._sum.amount?.toFixed(0) ?? "0", g.assetMint, "verified", now),
        ),
        liquidityReinforced: reserveRows("deployment").map((g) =>
          native(g._sum.amount?.toFixed(0) ?? "0", g.assetMint, "verified", now),
        ),
      },
      indexerUpdatedAt: indexedAt?.toISOString() ?? null,
    };
    return envelope(data);
  });
}
