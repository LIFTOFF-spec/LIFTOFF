import {
  CANDLE_INTERVAL_SECONDS,
  candleQuerySchema,
  CURVE_TARGET,
  rawToDecimal,
  FEE_CONFIG,
  pairForToken,
  pairsFor,
  RAYDIUM_RATE_DENOMINATOR,
  solanaAddressSchema,
  StonkFunUnavailableError,
  tokenQuerySchema,
  WSOL_MINT,
  type CandleSeries,
  type Pair,
  type PairDetail,
  type PairListResponse,
  type PairSummaryResponse,
  RATE_LIMITS,
  type StonkFunPair,
  type UsdRates,
  type Stat,
  type StonkFunInfo,
  type TokenListResponse,
  type TokenSummary,
  type UsedPair,
} from "@liftoff/shared";
import type { FastifyInstance } from "fastify";
import { envelope, parse, type AppContext } from "../app";
import { loadCandles } from "../lib/candles";
import { HttpError } from "../lib/errors";
import { enforceRateLimit } from "../lib/rate-limit";
import {
  buildLedger,
  emptyAggregates,
  loadAggregates,
  TOKEN_INCLUDE,
  toDetail,
  toSummary,
} from "../lib/tokens";
import { trimNumber } from "../lib/market-placeholder";

const num = (v: string | null) => (v === null ? 0 : Number(v));
// Urutan lintas pair lewat setara USD; tanpa harga (USD n/a) tetap berurutan lewat angka native.
const byUsdThenNative =
  (usd: (t: TokenSummary) => Stat, native: (t: TokenSummary) => Stat) =>
  (a: TokenSummary, b: TokenSummary) =>
    num(usd(b).value) - num(usd(a).value) || num(native(b).value) - num(native(a).value);

function sortAndFilter(items: TokenSummary[], filter: string): TokenSummary[] {
  switch (filter) {
    case "trending":
      // Aktivitas 24 jam dari trade terindeks; lintas pair dibandingkan lewat setara USD (estimasi).
      return items
        .filter((t) => num(t.volume24hQuote.value) > 0)
        .sort(
          byUsdThenNative(
            (t) => t.volume24hUsd,
            (t) => t.volume24hQuote,
          ),
        );
    case "graduating":
      return items
        .filter((t) => !t.graduated && num(t.curveProgressPct.value) >= 50)
        .sort((a, b) => num(b.curveProgressPct.value) - num(a.curveProgressPct.value));
    case "graduated":
      return items
        .filter((t) => t.graduated)
        .sort((a, b) => Date.parse(b.graduatedAt ?? "") - Date.parse(a.graduatedAt ?? ""));
    case "top-burns":
      return items
        .filter((t) => num(t.burnedSupplyPct.value) > 0)
        .sort((a, b) => num(b.burnedSupplyPct.value) - num(a.burnedSupplyPct.value));
    case "top-reserves":
      return items
        .filter((t) => num(t.reserveBalanceQuote.value) > 0)
        .sort(
          byUsdThenNative(
            (t) => t.reserveBalanceUsd,
            (t) => t.reserveBalanceQuote,
          ),
        );
    case "reinforced":
      return items.filter((t) => t.liquidityReinforced);
    default:
      return items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }
}

function toPair(p: StonkFunPair, rates: UsdRates): Pair {
  const assumed = rates.kind === "assumed";
  const graduationUsd =
    rates.kind === "live" && p.graduationRaw
      ? Number(rawToDecimal(BigInt(p.graduationRaw), p.decimals)) * rates.rateFor(p.mint)
      : Number.NaN;
  return {
    id: p.id,
    symbol: p.symbol,
    name: p.name,
    mint: p.mint,
    decimals: p.decimals,
    supported: p.launchable && p.launchLabReady,
    launchable: p.launchable,
    launchLabReady: p.launchLabReady,
    unavailableReason: p.unavailableReason,
    tokenized: p.tokenized,
    curveStart:
      p.assumedPriceUsd > 0 ? trimNumber(CURVE_TARGET.startMarketCapUsd / p.assumedPriceUsd) : null,
    // Raise graduation dari adapter (devnet: emulasi kurva setara USD; StonkFun: pricing.raise.raw).
    curveGraduation: p.graduationRaw
      ? rawToDecimal(BigInt(p.graduationRaw), p.decimals)
      : p.assumedPriceUsd > 0
        ? trimNumber(CURVE_TARGET.graduationUsd / p.assumedPriceUsd)
        : null,
    curveStartUsd: assumed ? String(CURVE_TARGET.startMarketCapUsd) : null,
    curveGraduationUsd: assumed
      ? String(CURVE_TARGET.graduationUsd)
      : Number.isFinite(graduationUsd)
        ? trimNumber(graduationUsd)
        : null,
    configId: p.configId,
    referralSupported: p.referralSupported,
    note: p.note,
    category: p.category,
    categoryLabel: p.categoryLabel,
    logoUrl: p.logoUrl,
    symbolAmbiguous: p.symbolAmbiguous,
    warnings: p.warnings,
  };
}

export async function tokenRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, config } = ctx;
  const pairs = pairsFor(config.cluster);

  /** StonkFun tidak bisa dibaca (RPC/emulasi) → 503 yang jelas, bukan daftar statis. */
  const viaStonkFun = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof StonkFunUnavailableError) {
        throw new HttpError(503, "stonkfun_unavailable", err.message);
      }
      throw err;
    }
  };

  // Spec §6: daftar pair dimuat dinamis lewat StonkFunAdapter (devnet: global config on-chain).
  // Satu request ke StonkFun: pricing per pair hanya saat pair dipilih (GET /api/pairs/:id).
  app.get("/api/pairs", async () => {
    const list = await viaStonkFun(() => ctx.stonkfun.listPairs());
    const rates = ctx.usdRates();
    return envelope<PairListResponse>(
      {
        pairs: list.pairs.map((p) => toPair(p, rates)),
        unavailable: list.unavailable,
        source: list.source,
        fetchedAt: list.fetchedAt,
      },
      "onchain",
    );
  });

  // Ringkas untuk halaman selain Create, supaya tidak mengirim seluruh daftar.
  app.get("/api/pairs/summary", async () => {
    const list = await viaStonkFun(() => ctx.stonkfun.listPairs());
    const categories = new Map<string, PairSummaryResponse["categories"][number]>();
    for (const p of list.pairs) {
      const key = p.category ?? "all";
      const c = categories.get(key) ?? {
        category: key,
        label: p.categoryLabel ?? p.category ?? "All",
        total: 0,
        available: 0,
      };
      c.total++;
      if (p.supported) c.available++;
      categories.set(key, c);
    }
    return envelope<PairSummaryResponse>(
      {
        total: list.pairs.length,
        available: list.pairs.filter((p) => p.supported).length,
        categories: [...categories.values()].sort((a, b) => b.total - a.total),
        unavailable: list.unavailable,
        source: list.source,
        fetchedAt: list.fetchedAt,
      },
      "onchain",
    );
  });

  // Quote yang benar-benar dipakai token live: dasar filter pair, tanpa request ke StonkFun.
  app.get("/api/pairs/used", async () => {
    const rows = await db.token.findMany({
      where: { launchStatus: "live", mint: { not: null } },
      distinct: ["quoteMint", "quoteConfigId"],
      select: { quoteMint: true, quoteConfigId: true },
    });
    const used = rows.flatMap((t): UsedPair[] => {
      const p = pairForToken(config.cluster, t);
      return p ? [{ id: p.id, symbol: p.symbol, name: p.name, mint: p.mint }] : [];
    });
    return envelope(used, "onchain");
  });

  app.get("/api/pairs/:id", async (req) => {
    await enforceRateLimit(ctx.kv, "pairDetail", RATE_LIMITS.pairDetail, { ip: req.ip });
    const { id } = req.params as { id: string };
    const list = await viaStonkFun(() => ctx.stonkfun.listPairs());
    const found = list.pairs.find((p) => p.id === id || p.mint === id);
    if (!found) throw new HttpError(404, "pair_not_found", "StonkFun does not list this pair.");
    const pair = await viaStonkFun(() => ctx.stonkfun.resolvePair(found));
    if (pair.mint !== WSOL_MINT) await ctx.awaitQuotePrice(pair.mint);
    const rates = ctx.usdRates();
    const rate = rates.kind === "none" ? Number.NaN : rates.rateFor(pair.mint);
    return envelope<PairDetail>(
      {
        ...toPair(pair, rates),
        quoteUsd: Number.isFinite(rate) && rate > 0 ? trimNumber(rate) : null,
      },
      "onchain",
    );
  });

  // Rule 10: config aktif & ketergantungan pada StonkFun / Raydium, dibaca on-chain.
  app.get("/api/stonkfun", async () => {
    const cfg = await viaStonkFun(() => ctx.stonkfun.activeLaunchConfig());
    const toBps = (rate: number) => (rate * 10_000) / RAYDIUM_RATE_DENOMINATOR;
    const dest = await viaStonkFun(() => ctx.stonkfun.creatorFeeDestination(pairs[0]?.mint ?? ""));
    const data: StonkFunInfo = {
      source: cfg.source,
      active: ctx.stonkfun.active,
      platformId: cfg.platformId,
      launchlabProgram: cfg.launchlabProgram,
      platformFeeBps: toBps(cfg.platformFeeRate),
      creatorFeeBps: toBps(cfg.creatorFeeRate),
      cpmmCreatorFeeBps: toBps(cfg.cpmmCreatorFeeRate),
      configured: {
        platformFeeBps: FEE_CONFIG.platformFeeBps,
        creatorFeeBps: FEE_CONFIG.creatorFeeBps,
        cpmmCreatorFeeBps: FEE_CONFIG.expectedCpmmCreatorFeeBps,
      },
      creatorFeeRecipient: dest.creator,
      split: {
        buybackBurnBps: FEE_CONFIG.split.buybackBurn,
        convictionReserveBps: FEE_CONFIG.split.convictionReserve,
      },
      fetchedAt: cfg.fetchedAt,
    };
    return envelope(data, "onchain");
  });
  app.get("/api/tokens", async (req) => {
    const q = tokenQuerySchema.parse(req.query);
    const rates = ctx.usdRates();
    // Filter memakai ID pair (bukan simbol saja): simbol pair StonkFun bisa dipakai lebih dari satu mint.
    const catalogued = q.pair?.startsWith("sf-") ? q.pair.slice(3) : null;
    const pair = q.pair ? pairs.find((p) => p.id === q.pair || p.symbol === q.pair) : undefined;
    if (q.pair && !pair && !catalogued) {
      return envelope<TokenListResponse>({ items: [], nextCursor: null });
    }

    // Urut di memori (skala devnet); metrik pasar dari snapshot indexer (loadAggregates).
    const tokens = await db.token.findMany({
      where: {
        launchStatus: "live",
        mint: { not: null },
        ...(catalogued ? { quoteMint: catalogued } : {}),
        ...(pair
          ? {
              quoteMint: pair.mint,
              ...(q.pair === pair.id ? { quoteConfigId: pair.configId } : {}),
            }
          : {}),
      },
      include: TOKEN_INCLUDE,
      orderBy: { createdAt: "desc" },
      take: 1_000,
    });
    const aggs = await loadAggregates(
      db,
      tokens.map((t) => t.mint!),
    );
    const items = sortAndFilter(
      tokens.map((t) =>
        toSummary(t, aggs.get(t.mint!) ?? emptyAggregates(), config.cluster, rates),
      ),
      q.filter,
    );
    const offset = q.cursor
      ? Number.parseInt(Buffer.from(q.cursor, "base64url").toString(), 10) || 0
      : 0;
    const page = items.slice(offset, offset + q.limit);
    const next =
      offset + q.limit < items.length
        ? Buffer.from(String(offset + q.limit)).toString("base64url")
        : null;
    return envelope<TokenListResponse>({ items: page, nextCursor: next });
  });

  const loadToken = async (mint: string) => {
    if (!solanaAddressSchema.safeParse(mint).success) return null;
    return db.token.findFirst({
      where: { mint, launchStatus: "live" },
      include: TOKEN_INCLUDE,
    });
  };

  app.get<{ Params: { mint: string } }>("/api/tokens/:mint", async (req) => {
    const token = await loadToken(req.params.mint);
    if (!token) throw new HttpError(404, "not_found", "Token not found.");
    const [aggs, trades, chartRows] = await Promise.all([
      loadAggregates(db, [token.mint!]),
      db.tradeReceipt.findMany({
        where: { tokenMint: token.mint! },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      db.tradeReceipt.findMany({
        where: { tokenMint: token.mint!, priceQuote: { not: null } },
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
    ]);
    return envelope(
      toDetail(
        token,
        aggs.get(token.mint!) ?? emptyAggregates(),
        config.cluster,
        ctx.usdRates(),
        trades,
        chartRows.reverse(),
      ),
    );
  });

  app.get<{ Params: { mint: string } }>("/api/tokens/:mint/candles", async (req) => {
    const token = await loadToken(req.params.mint);
    if (!token) throw new HttpError(404, "not_found", "Token not found.");
    const { interval } = parse(candleQuerySchema, req.query);
    const pair = pairForToken(config.cluster, token);
    const quoteUsd = pair ? ctx.usdRates().rateFor(pair.mint) : 0;
    const series: CandleSeries = {
      interval,
      candles: await loadCandles(
        db,
        token.mint!,
        CANDLE_INTERVAL_SECONDS[interval],
        pair?.decimals ?? null,
      ),
      quoteUsd: quoteUsd > 0 ? String(quoteUsd) : null,
    };
    return envelope(series);
  });

  // Spec §4 langkah 8: status adopsi token oleh StonkFun (devnet: emulasi).
  app.get<{ Params: { mint: string } }>("/api/tokens/:mint/adoption", async (req) => {
    const token = await loadToken(req.params.mint);
    if (!token) throw new HttpError(404, "not_found", "Token not found.");
    return envelope(
      await viaStonkFun(() => ctx.stonkfun.adoptionStatus(token.mint!, token.quoteMint)),
      "onchain",
    );
  });

  app.get<{ Params: { mint: string } }>("/api/tokens/:mint/ledger", async (req) => {
    const token = await loadToken(req.params.mint);
    if (!token) throw new HttpError(404, "not_found", "Token not found.");
    return envelope(await buildLedger(db, token, config.cluster, ctx.usdRates()));
  });
}
