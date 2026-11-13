/**
 * Membentuk response token & ledger dari database.
 *
 * Sumber kebenaran:
 *  - identitas token, status launch, ledger fee/burn/reserve → DB;
 *  - harga, market cap, volume, holder, likuiditas, progres curve, graduation, chart, riwayat
 *    trade → indexer Tahap 6 (`token_markets`, `token_graduations`, `trade_receipts`), dibaca
 *    dari chain. Angka native (quote pair / token) bertanda `indexer` dengan status `verified`
 *    (snapshot segar) atau `delayed` (indexer tertinggal); tanpa snapshot → `unavailable`.
 *  - konversi USD: devnet tidak punya harga → harga ASUMSI pair, selalu MOCK/estimated; mainnet →
 *    harga SOL/USD terverifikasi saat ini (estimated), atau tidak tersedia. `token_markets` hanya
 *    menyimpan angka native, jadi USD selalu dihitung saat dibaca, tidak pernah dari angka lama.
 * Nominal disimpan dalam satuan terkecil dan dikonversi dengan aritmetika bigint (tanpa float).
 */
import {
  reserveBalances,
  type Db,
  type Token,
  type TokenGraduation,
  type TokenMarket,
  type User,
} from "@liftoff/db";
import {
  CURVE_TARGET,
  curveProgressPct,
  freshness,
  INDEXER_CONFIG,
  pairForMint,
  pairForToken,
  pctChange,
  platformFor,
  RESERVE_CONFIG,
  valueAtPrice,
  type BurnLedgerEntry,
  type FeeLedgerEntry,
  type GraduationCheck,
  type GraduationInfo,
  type GraduationState,
  type PricePoint,
  type ReserveLedgerEntry,
  type ReserveMode,
  type ReserveState,
  type SolanaCluster,
  type Stat,
  type StatStatus,
  type TokenDetail,
  type TokenLedger,
  type TokenLinks,
  type TokenSummary,
  type UsdRates,
} from "@liftoff/shared";
import { buildTokenEconomics } from "./economics";
import { usdStat } from "./market-placeholder";
import { loadTokenReserveExtras } from "./reserve";

const DAY_MS = 86_400_000;
const TOTAL_SUPPLY_RAW =
  BigInt(CURVE_TARGET.totalSupply) * 10n ** BigInt(CURVE_TARGET.tokenDecimals);

/** Satuan terkecil → string desimal (mis. 1102540 lamport, 9 → "0.00110254"). */
export function formatUnits(raw: bigint | string, decimals: number): string {
  const value = typeof raw === "bigint" ? raw : BigInt(raw);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Persentase a/b dengan 4 desimal, tanpa float untuk pembagian. */
export function percent(a: bigint, b: bigint): string {
  if (b === 0n) return "0";
  return formatUnits((a * 1_000_000n) / b, 4);
}

export function indexerStat(
  value: string | null,
  unit: string,
  status: StatStatus = "verified",
  updatedAt: Date | null = new Date(),
): Stat {
  if (value === null)
    return { value: null, unit, status: "unavailable", updatedAt: null, source: "indexer" };
  return { value, unit, status, updatedAt: updatedAt?.toISOString() ?? null, source: "indexer" };
}

/** Decimal Prisma → string desimal polos (Decimal(65,30) bisa berupa notasi eksponen). */
const dec = (d: { toFixed(n?: number): string }, digits = 30) =>
  d
    .toFixed(digits)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
const raw = (d: { toFixed(n: number): string } | null | undefined) =>
  d ? BigInt(d.toFixed(0)) : 0n;

export interface TokenAggregates {
  burnedRaw: bigint;
  reserveContributed: bigint;
  reserveDeployed: bigint;
  /** Deployment dengan lock LP terverifikasi on-chain (kategori "Liquidity Reinforced"). */
  verifiedDeployments: number;
  reserveCorrection: bigint;
  /** Reserve dari creator fee yang sudah di-claim & direkonsiliasi (Tahap 7; termasuk koreksi). */
  reserveClaimed: bigint;
  /** Reserve dari fee yang tercatat per trade tetapi belum di-claim (Rule 9: bukan saldo). */
  reserveAwaitingClaim: bigint;
  lastDeployAt: Date | null;
  /** Snapshot indexer (null = belum diindeks). */
  market: TokenMarket | null;
  graduation: TokenGraduation | null;
  /** Volume dari trade_receipts (satuan terkecil quote). */
  volume24hRaw: bigint;
  volumeTotalRaw: bigint;
  /** Harga pembanding 24 jam: trade terakhir ≤ 24 jam lalu, atau trade pertama dalam 24 jam. */
  priceRef24h: string | null;
}

export const emptyAggregates = (): TokenAggregates => ({
  burnedRaw: 0n,
  reserveContributed: 0n,
  reserveDeployed: 0n,
  verifiedDeployments: 0,
  reserveCorrection: 0n,
  reserveClaimed: 0n,
  reserveAwaitingClaim: 0n,
  lastDeployAt: null,
  market: null,
  graduation: null,
  volume24hRaw: 0n,
  volumeTotalRaw: 0n,
  priceRef24h: null,
});

export async function loadAggregates(
  db: Db,
  mints: string[],
  now = new Date(),
): Promise<Map<string, TokenAggregates>> {
  const out = new Map<string, TokenAggregates>(mints.map((m) => [m, emptyAggregates()]));
  if (mints.length === 0) return out;
  const get = (m: string) => out.get(m)!;
  const since = new Date(now.getTime() - DAY_MS);

  const [burns, reserves, deploys, markets, graduations, vol24, volAll, refs, split, verified] =
    await Promise.all([
      db.burnLedger.groupBy({
        by: ["tokenMint"],
        where: { tokenMint: { in: mints } },
        _sum: { amountBurned: true },
      }),
      db.reserveLedger.groupBy({
        by: ["tokenMint", "entryType"],
        where: { tokenMint: { in: mints } },
        _sum: { amount: true },
      }),
      db.reserveLedger.groupBy({
        by: ["tokenMint"],
        where: { tokenMint: { in: mints }, entryType: "deployment" },
        _max: { createdAt: true },
      }),
      db.tokenMarket.findMany({ where: { tokenMint: { in: mints } } }),
      db.tokenGraduation.findMany({ where: { tokenMint: { in: mints } } }),
      db.tradeReceipt.groupBy({
        by: ["tokenMint"],
        where: { tokenMint: { in: mints }, createdAt: { gte: since } },
        _sum: { amountQuote: true },
      }),
      db.tradeReceipt.groupBy({
        by: ["tokenMint"],
        where: { tokenMint: { in: mints } },
        _sum: { amountQuote: true },
      }),
      db.$queryRaw<Array<{ tokenMint: string; price: string }>>`
        SELECT DISTINCT ON ("tokenMint") "tokenMint", "priceQuote"::text AS price
        FROM (
          SELECT "tokenMint", "priceQuote", "createdAt", 0 AS pref FROM "trade_receipts"
            WHERE "tokenMint" = ANY(${mints}) AND "priceQuote" IS NOT NULL AND "createdAt" <= ${since}
          UNION ALL
          SELECT "tokenMint", "priceQuote", "createdAt", 1 AS pref FROM "trade_receipts"
            WHERE "tokenMint" = ANY(${mints}) AND "priceQuote" IS NOT NULL AND "createdAt" > ${since}
        ) r
        ORDER BY "tokenMint", pref,
          CASE WHEN pref = 0 THEN -EXTRACT(EPOCH FROM "createdAt") ELSE EXTRACT(EPOCH FROM "createdAt") END`,
      mints.length === 1 ? reserveBalances(db, { tokenMint: mints[0]! }) : reserveBalances(db),
      db.reserveDeployment.groupBy({
        by: ["tokenMint"],
        where: { tokenMint: { in: mints }, lockVerified: true },
        _count: true,
      }),
    ]);
  for (const b of burns) get(b.tokenMint).burnedRaw = raw(b._sum.amountBurned);
  for (const r of reserves) {
    const amount = raw(r._sum.amount);
    const agg = get(r.tokenMint);
    if (r.entryType === "contribution") agg.reserveContributed += amount;
    if (r.entryType === "deployment") agg.reserveDeployed += amount;
    if (r.entryType === "correction") agg.reserveCorrection += amount;
  }
  for (const d of deploys) get(d.tokenMint).lastDeployAt = d._max.createdAt;
  for (const v of verified) get(v.tokenMint).verifiedDeployments = v._count;
  for (const m of markets) get(m.tokenMint).market = m;
  for (const g of graduations) get(g.tokenMint).graduation = g;
  for (const v of vol24) get(v.tokenMint).volume24hRaw = raw(v._sum.amountQuote);
  for (const v of volAll) get(v.tokenMint).volumeTotalRaw = raw(v._sum.amountQuote);
  for (const r of refs) get(r.tokenMint).priceRef24h = r.price;
  for (const s of split) {
    const agg = out.get(s.tokenMint);
    if (!agg) continue;
    agg.reserveClaimed += s.claimed;
    agg.reserveAwaitingClaim += s.accrued - s.claimed;
  }
  return out;
}

/**
 * Jenis entri fee untuk total: satu koreksi ditulis tiga baris (bucket received/buyback/reserve),
 * jadi tiap baris dihitung ke kelompoknya sendiri, tidak dijumlahkan sebagai "correction".
 */
export function feeEntryKind(f: { entryType: string; bucket: string | null }): string {
  if (f.entryType !== "correction") return f.entryType;
  if (f.bucket === "buyback") return "allocated_buyback";
  if (f.bucket === "reserve") return "allocated_reserve";
  return "received";
}

/** Saldo reserve = porsi yang sudah di-claim (dana diterima) − deployment. */
export const reserveBalance = (a: TokenAggregates) => a.reserveClaimed - a.reserveDeployed;

/**
 * Spec §14 / Rule 7: fase deploy likuiditas hanya setelah graduation + pool terverifikasi. Token
 * yang belum graduate tetap `accumulating` selamanya — reserve-nya disimpan, tidak pernah dipakai.
 */
export function reserveMode(token: Token, agg: TokenAggregates): ReserveMode {
  return token.graduatedAt && agg.graduation?.reserveMonitoringActive
    ? "deploying_liquidity"
    : "accumulating";
}

/**
 * Simbol & desimal sebuah aset ledger. Quote ada di registri atau katalog; aset lain adalah token
 * LIFTOFF sendiri (fee CPMM berdenominasi token), yang selalu 6 desimal.
 */
export function assetInfo(cluster: SolanaCluster, mint: string) {
  const pair = pairForMint(cluster, mint);
  return pair
    ? { symbol: pair.symbol, decimals: pair.decimals }
    : { symbol: mint.slice(0, 4), decimals: CURVE_TARGET.tokenDecimals };
}

function quoteInfo(cluster: SolanaCluster, rates: UsdRates, token: Token) {
  const pair = pairForToken(cluster, token);
  return {
    symbol: pair?.symbol ?? "?",
    // Quote belum dikenal: angka native tidak ditampilkan (lihat `native`), tidak menebak desimal.
    known: !!pair,
    decimals: pair?.decimals ?? CURVE_TARGET.tokenDecimals,
    usd: pair ? rates.rateFor(pair.mint) : Number.NaN,
    // USD per titik riwayat (chart, trade) hanya untuk harga asumsi: harga SOL hari ini bukan harga
    // pada waktu trade itu, jadi di mainnet riwayat tetap dalam SOL.
    hasHistoryUsd: rates.kind === "assumed",
  };
}

/** Relasi yang dibutuhkan serializer token. */
export const TOKEN_INCLUDE = {
  creator: { select: { wallet: true, xHandle: true } },
  // Klaim X ada hanya jika koin diluncurkan dengan akun X tertaut → "verified creator".
  xClaims: { where: { status: "active" }, select: { xUserId: true }, take: 1 },
} as const;

type TokenWithCreator = Token & {
  creator: Pick<User, "wallet" | "xHandle">;
  xClaims: Array<{ xUserId: string }>;
};

/** Angka pasar native + turunannya untuk satu token (dipakai summary & detail). */
function marketFigures(
  token: Token,
  agg: TokenAggregates,
  cluster: SolanaCluster,
  rates: UsdRates,
  now: number,
) {
  const quote = quoteInfo(cluster, rates, token);
  const m = agg.market;
  const status = m ? freshness(m.indexedAt, now) : "unavailable";
  const at = m?.indexedAt ?? null;
  const price = m?.priceQuote ? dec(m.priceQuote) : null;
  const marketCapRaw =
    m && price
      ? valueAtPrice(price, raw(m.supplyRaw), CURVE_TARGET.tokenDecimals, quote.decimals)
      : null;
  const native = (value: string | null, unit = quote.symbol) =>
    m && value !== null && quote.known
      ? indexerStat(value, unit, status as StatStatus, at)
      : indexerStat(null, unit);
  // USD = native × harga pair saat ini (estimasi), hanya bila native-nya ada.
  const usd = (nativeValue: string | null) =>
    nativeValue === null || !m || !quote.known
      ? usdStat(rates, null)
      : usdStat(rates, Number(nativeValue) * quote.usd);
  const marketCap = marketCapRaw === null ? null : formatUnits(marketCapRaw, quote.decimals);
  const volume24h = formatUnits(agg.volume24hRaw, quote.decimals);
  const graduated = token.graduatedAt !== null;
  const progress =
    graduated || (m && m.curveStatus > 0)
      ? "100"
      : m
        ? curveProgressPct(raw(m.curveRaisedRaw), raw(m.curveTargetRaw))
        : null;
  return { quote, m, status, at, price, marketCap, volume24h, progress, native, usd };
}

function graduationState(agg: TokenAggregates): GraduationState {
  if (agg.graduation) return agg.graduation.state;
  if (agg.market?.curveStatus === 1) return "migrating";
  if (agg.market?.curveStatus === 2) return "pool_pending";
  return "not_graduated";
}

export function toSummary(
  token: TokenWithCreator,
  agg: TokenAggregates,
  cluster: SolanaCluster,
  rates: UsdRates,
  now = Date.now(),
): TokenSummary {
  const f = marketFigures(token, agg, cluster, rates, now);
  const graduated = token.graduatedAt !== null;
  const balance = reserveBalance(agg);
  const reserveUsd = Number(formatUnits(balance, f.quote.decimals)) * f.quote.usd;
  return {
    id: token.id,
    mint: token.launchStatus === "live" ? token.mint : null,
    name: token.name,
    ticker: token.ticker,
    imageUrl: token.imageUrl,
    quoteSymbol: f.quote.symbol,
    quoteMint: token.quoteMint,
    quoteDecimals: f.quote.known ? f.quote.decimals : null,
    creatorWallet: token.creator.wallet,
    creatorXHandle:
      token.xClaims.length > 0 && token.creator.xHandle ? `@${token.creator.xHandle}` : null,
    verifiedCreator: token.xClaims.length > 0,
    launchStatus: token.launchStatus,
    createdAt: token.createdAt.toISOString(),
    graduated,
    graduatedAt: token.graduatedAt?.toISOString() ?? null,
    liquidityReinforced: agg.verifiedDeployments > 0,
    reserveMode: reserveMode(token, agg),
    graduationState: graduationState(agg),
    priceQuote: f.native(f.price),
    marketCapQuote: f.native(f.marketCap),
    volume24hQuote: f.native(f.volume24h),
    volumeTotalQuote: f.native(formatUnits(agg.volumeTotalRaw, f.quote.decimals)),
    volumeTotalUsd: f.usd(formatUnits(agg.volumeTotalRaw, f.quote.decimals)),
    priceUsd: f.usd(f.price),
    marketCapUsd: f.usd(f.marketCap),
    volume24hUsd: f.usd(f.volume24h),
    priceChange24hPct: f.native(pctChange(agg.priceRef24h, f.price), "%"),
    curveProgressPct: graduated
      ? indexerStat("100", "%", "verified", token.graduatedAt)
      : f.native(f.progress, "%"),
    burnedSupplyPct: indexerStat(percent(agg.burnedRaw, TOTAL_SUPPLY_RAW), "%"),
    burnedTokens: indexerStat(formatUnits(agg.burnedRaw, CURVE_TARGET.tokenDecimals), token.ticker),
    // Saldo reserve dari ledger; konversi ke USD adalah estimasi (devnet: asumsi, bertanda MOCK).
    reserveBalanceQuote: indexerStat(formatUnits(balance, f.quote.decimals), f.quote.symbol),
    reserveBalanceUsd: balance === 0n ? indexerStat("0", "USD") : usdStat(rates, reserveUsd),
    riskLevel: token.riskLevel,
  };
}

function links(value: unknown): TokenLinks {
  const v = (value ?? {}) as Partial<Record<keyof TokenLinks, unknown>>;
  const s = (x: unknown) => (typeof x === "string" && x ? x : null);
  return { website: s(v.website), telegram: s(v.telegram), x: s(v.x) };
}

export interface TradeRow {
  signature: string;
  side: string;
  wallet: string;
  amountToken: { toFixed(d: number): string };
  amountQuote: { toFixed(d: number): string };
  priceQuote?: { toFixed(d?: number): string } | null;
  createdAt: Date;
}

const pctOf = (part: unknown, total: unknown) => {
  const t = raw(total as { toFixed(n: number): string } | null);
  return t > 0n ? percent(raw(part as { toFixed(n: number): string } | null), t) : null;
};

export function graduationInfo(g: TokenGraduation | null): GraduationInfo | null {
  if (!g) return null;
  return {
    state: g.state,
    launchPool: g.launchPool,
    cpmmPool: g.cpmmPool,
    migrateSignature: g.migrateSignature,
    migratedAt: g.migratedAt?.toISOString() ?? null,
    lpMint: g.lpMint,
    lpBurnedPct: pctOf(g.lpBurnedRaw, g.lpTotalRaw),
    lpLockedPct: pctOf(g.lpLockedRaw, g.lpTotalRaw),
    lpFreePct: pctOf(g.lpFreeRaw, g.lpTotalRaw),
    addLiquiditySupported: g.addLiquiditySupported,
    reserveMonitoringActive: g.reserveMonitoringActive,
    checks: (g.checks ?? []) as unknown as GraduationCheck[],
    checkedAt: g.checkedAt.toISOString(),
    verifiedAt: g.verifiedAt?.toISOString() ?? null,
  };
}

export function toDetail(
  token: TokenWithCreator,
  agg: TokenAggregates,
  cluster: SolanaCluster,
  rates: UsdRates,
  /** Receipt trade terverifikasi on-chain, terbaru dulu (Spec §16 Section 4). */
  trades: TradeRow[] = [],
  /** Receipt dengan harga untuk chart, urut waktu naik. */
  chartRows: TradeRow[] = [],
  now = Date.now(),
): TokenDetail {
  const summary = toSummary(token, agg, cluster, rates, now);
  const f = marketFigures(token, agg, cluster, rates, now);
  const m = f.m;
  const remaining =
    m && !summary.graduated && m.curveStatus === 0
      ? formatUnits(
          raw(m.curveTargetRaw) > raw(m.curveRaisedRaw)
            ? raw(m.curveTargetRaw) - raw(m.curveRaisedRaw)
            : 0n,
          f.quote.decimals,
        )
      : m
        ? "0"
        : null;
  const liquidity = m ? formatUnits(raw(m.liquidityQuoteRaw), f.quote.decimals) : null;
  // Holder disegarkan lebih jarang (getProgramAccounts) → freshness memakai interval itu.
  const holdersStatus =
    m?.holdersAt != null
      ? freshness(m.holdersAt, now, INDEXER_CONFIG.holdersRefreshMs + INDEXER_CONFIG.staleAfterMs)
      : "unavailable";
  const chart: PricePoint[] = chartRows
    .filter((r) => r.priceQuote)
    .map((r) => {
      const p = dec(r.priceQuote!);
      return {
        t: r.createdAt.toISOString(),
        priceQuote: p,
        priceUsd: f.quote.hasHistoryUsd ? String(Number(p) * f.quote.usd) : null,
      };
    });
  if (chart.length > 0 && f.price) {
    chart.push({
      t: (m?.indexedAt ?? new Date(now)).toISOString(),
      priceQuote: f.price,
      priceUsd: f.quote.hasHistoryUsd ? String(Number(f.price) * f.quote.usd) : null,
    });
  }
  return {
    ...summary,
    description: token.description,
    links: links(token.links),
    totalSupply: CURVE_TARGET.totalSupply,
    liquidityQuote: f.native(liquidity),
    liquidityUsd: f.usd(liquidity),
    holders:
      m?.holders != null && holdersStatus !== "unavailable"
        ? indexerStat(String(m.holders), "holders", holdersStatus, m.holdersAt)
        : indexerStat(null, "holders"),
    curveRemainingQuote: f.native(remaining),
    curveRemainingUsd: f.usd(remaining),
    poolAddress: agg.graduation?.cpmmPool ?? m?.cpmmPool ?? m?.launchPool ?? null,
    graduation: graduationInfo(agg.graduation),
    chart,
    recentTrades: trades.map((t) => {
      const tokens = Number(formatUnits(t.amountToken.toFixed(0), CURVE_TARGET.tokenDecimals));
      const quoteAmt = Number(formatUnits(t.amountQuote.toFixed(0), f.quote.decimals));
      return {
        signature: t.signature,
        side: t.side === "sell" ? "sell" : "buy",
        wallet: t.wallet,
        amountToken: formatUnits(t.amountToken.toFixed(0), CURVE_TARGET.tokenDecimals),
        amountQuote: formatUnits(t.amountQuote.toFixed(0), f.quote.decimals),
        quoteSymbol: f.quote.symbol,
        // Jumlah on-chain terverifikasi; harga USD memakai harga ASUMSI pair → estimasi.
        priceUsd: f.quote.hasHistoryUsd
          ? String(tokens > 0 ? (quoteAmt / tokens) * f.quote.usd : 0)
          : null,
        createdAt: t.createdAt.toISOString(),
        status: "verified" as const,
      };
    }),
  };
}

export async function buildLedger(
  db: Db,
  token: TokenWithCreator,
  cluster: SolanaCluster,
  rates: UsdRates,
): Promise<TokenLedger> {
  const mint = token.mint!;
  const quote = quoteInfo(cluster, rates, token);
  const symbolOf = (assetMint: string) => assetInfo(cluster, assetMint).symbol;
  const decimalsOf = (assetMint: string) => assetInfo(cluster, assetMint).decimals;

  const [fees, burns, reserve, override, aggs] = await Promise.all([
    db.feeLedger.findMany({
      where: { tokenMint: mint },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    db.burnLedger.findMany({
      where: { tokenMint: mint },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    db.reserveLedger.findMany({
      where: { tokenMint: mint },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    db.reserveConfigOverride.findUnique({ where: { tokenMint: mint } }),
    loadAggregates(db, [mint]),
  ]);
  const agg = aggs.get(mint) ?? emptyAggregates();

  const feeEntries: FeeLedgerEntry[] = fees.map((f) => ({
    id: f.id,
    sourceSignature: f.sourceSignature,
    tokenMint: f.tokenMint,
    amount: formatUnits(f.amount.toFixed(0), decimalsOf(f.assetMint)),
    assetSymbol: symbolOf(f.assetMint),
    entryType: f.entryType,
    source: f.source,
    attribution: f.attribution,
    createdAt: f.createdAt.toISOString(),
  }));
  const burnEntries: BurnLedgerEntry[] = burns.map((b) => ({
    id: b.id,
    tokenMint: b.tokenMint,
    amountBurned: formatUnits(b.amountBurned.toFixed(0), CURVE_TARGET.tokenDecimals),
    amountSpent: formatUnits(b.amountSpent.toFixed(0), decimalsOf(b.assetMint)),
    assetSymbol: symbolOf(b.assetMint),
    source: b.source,
    buybackSignature: b.buybackSignature,
    burnSignature: b.burnSignature,
    createdAt: b.createdAt.toISOString(),
  }));
  const reserveEntries: ReserveLedgerEntry[] = reserve.map((r) => ({
    id: r.id,
    tokenMint: r.tokenMint,
    entryType: r.entryType,
    amount: formatUnits(r.amount.toFixed(0), decimalsOf(r.assetMint)),
    assetSymbol: symbolOf(r.assetMint),
    txSignature: r.txSignature,
    createdAt: r.createdAt.toISOString(),
  }));

  // Total per jenis entri (bigint, satuan terkecil quote).
  // Model Spec: total hanya dari creator fee (entri platform_vault/referral lama = legacy).
  const sumFees = (type: string) =>
    fees
      .filter((f) => feeEntryKind(f) === type && f.source === "creator_fee")
      .reduce((acc, f) => acc + BigInt(f.amount.toFixed(0)), 0n);
  const anyEstimated = fees.some(
    (f) => f.source === "creator_fee" && f.attribution === "estimated",
  );
  const feeStatus: StatStatus = anyEstimated ? "estimated" : "verified";
  const received = sumFees("received");
  const allocBuyback = sumFees("allocated_buyback");
  const economics = await buildTokenEconomics(db, cluster, {
    mint,
    quoteMint: token.quoteMint,
    ticker: token.ticker,
  });

  const params = {
    ...RESERVE_CONFIG,
    ...((override?.params ?? {}) as Partial<typeof RESERVE_CONFIG>),
  };
  const overridden = Object.keys((override?.params ?? {}) as object);
  const balance = reserveBalance(agg);
  const mode = reserveMode(token, agg);
  const extras = await loadTokenReserveExtras(
    db,
    cluster,
    rates,
    platformFor(cluster).masterWallet,
    { mint, quoteMint: token.quoteMint },
  );
  const holdReasons: string[] = [];
  if (override?.paused) holdReasons.push("This token's reserve is paused (per-token pause).");
  if (mode === "accumulating") {
    holdReasons.push(
      token.graduatedAt
        ? "Graduated, but reserve monitoring stays off until the migrated pool is verified and supports add-liquidity (Spec §14)."
        : "Token has not graduated yet. Its reserve is held untouched until graduation and pool verification (Spec §14).",
    );
  } else if (extras.latestDecision && !extras.latestDecision.allowed) {
    holdReasons.push(...extras.latestDecision.reasons);
  }
  if (balance === 0n) holdReasons.push("Reserve balance is empty.");
  const lastDeploy = extras.deployments[0] ?? null;
  const nextAt = lastDeploy
    ? new Date(new Date(lastDeploy.createdAt).getTime() + params.cooldownSeconds * 1000)
    : null;

  const reserveState: ReserveState = {
    tokenMint: mint,
    mode,
    paused: override?.paused ?? false,
    balance: indexerStat(formatUnits(balance, quote.decimals), quote.symbol),
    balanceUsd:
      balance === 0n
        ? indexerStat("0", "USD")
        : usdStat(rates, Number(formatUnits(balance, quote.decimals)) * quote.usd),
    awaitingClaim: indexerStat(
      formatUnits(agg.reserveAwaitingClaim > 0n ? agg.reserveAwaitingClaim : 0n, quote.decimals),
      quote.symbol,
      "delayed",
    ),
    totalContributed: indexerStat(
      formatUnits(agg.reserveContributed + agg.reserveCorrection, quote.decimals),
      quote.symbol,
    ),
    totalDeployed: indexerStat(formatUnits(agg.reserveDeployed, quote.decimals), quote.symbol),
    createdAt: token.createdAt.toISOString(),
    lastDeployAt: agg.lastDeployAt?.toISOString() ?? null,
    nextActionEarliestAt: nextAt && nextAt.getTime() > Date.now() ? nextAt.toISOString() : null,
    deploysInWindow: extras.deployments.filter(
      (d) => Date.now() - new Date(d.createdAt).getTime() < params.deployWindowSeconds * 1000,
    ).length,
    params: {
      minBalanceToDeployUsd: params.minBalanceToDeployUsd,
      maxDeployPctPerRunBps: params.maxDeployPctPerRunBps,
      maxDeployAbsPerRunUsd: params.maxDeployAbsPerRunUsd,
      maxReserveShareOfPoolBps: params.maxReserveShareOfPoolBps,
      cooldownSeconds: params.cooldownSeconds,
      maxDeploysPerWindow: params.maxDeploysPerWindow,
      deployWindowSeconds: params.deployWindowSeconds,
      minTimeSinceGraduationSeconds: params.minTimeSinceGraduationSeconds,
      overridden,
    },
    holdReasons,
    poolAddress: agg.graduation?.cpmmPool ?? null,
    // "locked" hanya bila burn LP deployment terbukti dari transaksi on-chain (Spec §11 Phase 4).
    lpLock: lastDeploy
      ? {
          status: extras.deployments.every((d) => d.lock.verified) ? "locked" : "unverified",
          proofSignature: lastDeploy.lock.proofSignature,
        }
      : { status: token.graduatedAt ? "pending" : "not_applicable", proofSignature: null },
    ...extras,
  };

  return {
    fees: feeEntries,
    burns: burnEntries,
    reserve: reserveEntries,
    reserveState,
    economics,
    totals: {
      feesReceived: indexerStat(formatUnits(received, quote.decimals), quote.symbol, feeStatus),
      allocatedBuyback: indexerStat(
        formatUnits(allocBuyback, quote.decimals),
        quote.symbol,
        feeStatus,
      ),
      allocatedReserve: indexerStat(
        formatUnits(sumFees("allocated_reserve"), quote.decimals),
        quote.symbol,
        feeStatus,
      ),

      burnedTokens: indexerStat(
        formatUnits(agg.burnedRaw, CURVE_TARGET.tokenDecimals),
        token.ticker,
      ),
      burnedSupplyPct: indexerStat(percent(agg.burnedRaw, TOTAL_SUPPLY_RAW), "%"),
      buybackPending: economics.budgetAvailable,
    },
  };
}
