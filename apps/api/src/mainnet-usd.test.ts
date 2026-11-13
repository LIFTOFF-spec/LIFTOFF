import { saveQuoteAsset } from "@liftoff/db";
import {
  evaluateSolPrice,
  pairsFor,
  SOL_PRICE_CONFIG,
  usdRatesFor,
  type SolPriceReader,
  type SolPriceSnapshot,
} from "@liftoff/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockStat, usdStat } from "./lib/market-placeholder";
import { makeApp, newWallet, nextIp, resetDb } from "./test-helpers";

const WSOL = "So11111111111111111111111111111111111111112";
const MASTER = "HxM1EeyZ9z71m8mu5x9bsUdtTP1f9qtT7mo9D5tB3xwM";

/** Harga palsu yang bisa diganti di tengah test. */
function priceAt(usdA: number | null, usdB: number | null, ageSeconds = 30): SolPriceSnapshot {
  const now = Date.now();
  const reading = (usd: number | null) =>
    usd === null
      ? { observation: null, error: "HTTP 503" }
      : { observation: { usd, observedAtMs: now - ageSeconds * 1000 }, error: null };
  return evaluateSolPrice(reading(usdA), reading(usdB), SOL_PRICE_CONFIG, now);
}
const VERIFIED = priceAt(100, 100);
const UNVERIFIED = priceAt(100, null);

describe("usdStat", () => {
  it("devnet: estimasi berlabel MOCK, tidak terpengaruh harga mainnet", () => {
    expect(usdStat(usdRatesFor("devnet", UNVERIFIED), 5)).toEqual(mockStat(5, "USD"));
  });

  it("mainnet tanpa harga terverifikasi: tidak tersedia, bukan angka", () => {
    for (const snapshot of [UNVERIFIED, null]) {
      expect(usdStat(usdRatesFor("mainnet-beta", snapshot), 5)).toEqual({
        value: null,
        unit: "USD",
        status: "unavailable",
        updatedAt: null,
        source: "indexer",
      });
    }
  });

  it("mainnet dengan harga terverifikasi: selalu estimasi, tidak pernah verified atau MOCK", () => {
    const rates = usdRatesFor("mainnet-beta", VERIFIED);
    for (const status of ["verified", "estimated"] as const) {
      expect(usdStat(rates, 5, status)).toEqual({
        value: "5",
        unit: "USD",
        status: "estimated",
        updatedAt: VERIFIED.observedAt,
        source: "price_feed",
      });
    }
    expect(usdStat(rates, 5, "delayed").status).toBe("delayed");
    expect(usdStat(rates, null).status).toBe("unavailable");
  });

  it("mainnet tidak punya harga asumsi di config", () => {
    for (const p of pairsFor("mainnet-beta")) expect(p.assumedPriceUsd).toBe(0);
  });
});

describe("API di mainnet: tidak ada USD palsu", () => {
  type Ctx = Awaited<ReturnType<typeof makeApp>>;
  let ctx: Ctx;
  const before = process.env.MASTER_WALLET_PUBKEY;
  let snapshot: SolPriceSnapshot = UNVERIFIED;
  const solPrice: SolPriceReader = {
    current: () => snapshot,
    read: async () => snapshot,
  };
  let quoteSnapshots: Record<string, SolPriceSnapshot> = {};
  const quotePrices = { current: (mint: string) => quoteSnapshots[mint] ?? UNVERIFIED };

  beforeAll(async () => {
    process.env.MASTER_WALLET_PUBKEY = MASTER;
    ctx = await makeApp({ config: { cluster: "mainnet-beta" }, solPrice, quotePrices });
  }, 120_000);
  afterAll(async () => {
    if (before === undefined) delete process.env.MASTER_WALLET_PUBKEY;
    else process.env.MASTER_WALLET_PUBKEY = before;
    await ctx.app.close();
  });
  beforeEach(async () => {
    snapshot = UNVERIFIED;
    quoteSnapshots = {};
    await resetDb(ctx.db);
  });

  async function seed() {
    const mint = newWallet().address;
    const user = await ctx.db.user.create({ data: { wallet: newWallet().address } });
    await ctx.db.token.create({
      data: {
        name: "Real",
        ticker: "REAL",
        tickerNormalized: "real",
        mint,
        quoteMint: WSOL,
        quoteConfigId: pairsFor("mainnet-beta")[0]!.configId,
        creatorUserId: user.id,
        launchStatus: "live",
      },
    });
    for (const [entryType, amount] of [
      ["received", "1000000000"],
      ["allocated_buyback", "800000000"],
      ["allocated_reserve", "200000000"],
    ] as const) {
      await ctx.db.feeLedger.create({
        data: {
          sourceSignature: `sig-${mint}-${entryType}`,
          tokenMint: mint,
          amount,
          assetMint: WSOL,
          entryType,
          source: "creator_fee",
          attribution: "verified",
        },
      });
    }
    return mint;
  }

  const get = async (url: string) =>
    (await ctx.app.inject({ method: "GET", url })).json().data as Record<string, never>;

  it("koreksi tiga bucket dihitung ke kelompoknya, fee diterima tidak berlipat", async () => {
    const mint = await seed();
    type Row = {
      tokenMint: string;
      feesReceivedNative: string;
      buybackNative: string;
      reserveNative: string;
    };
    const row = async () =>
      ((await get("/api/transparency")) as unknown as { perToken: Row[] }).perToken.find(
        (r) => r.tokenMint === mint,
      )!;
    const before = await row();
    for (const [bucket, amount] of [
      ["received", "1000000000"],
      ["buyback", "800000000"],
      ["reserve", "200000000"],
    ] as const) {
      await ctx.db.feeLedger.create({
        data: {
          sourceSignature: `forward-${mint}`,
          tokenMint: mint,
          amount,
          assetMint: WSOL,
          entryType: "correction",
          bucket,
          source: "creator_fee",
          attribution: "estimated",
        },
      });
    }
    const after = await row();
    expect(Number(after.feesReceivedNative) - Number(before.feesReceivedNative)).toBeCloseTo(1, 6);
    expect(Number(after.buybackNative) - Number(before.buybackNative)).toBeCloseTo(0.8, 6);
    expect(Number(after.reserveNative) - Number(before.reserveNative)).toBeCloseTo(0.2, 6);
  });

  it("statistik, transparansi, aktivitas, dan token tanpa MOCK; native tetap ada", async () => {
    const mint = await seed();
    const [stats, transparency, activity, token, list] = await Promise.all([
      get("/api/stats"),
      get("/api/transparency"),
      get("/api/activity"),
      get(`/api/tokens/${mint}`),
      get("/api/tokens"),
    ]);
    for (const body of [stats, transparency, activity, token, list]) {
      expect(JSON.stringify(body)).not.toContain('"source":"mock"');
    }
    expect(stats).toMatchObject({ tradingVolumeUsd: { value: null, status: "unavailable" } });
    // Ledger append-only (tidak dikosongkan antar test): cek baris token ini saja.
    expect(transparency).toMatchObject({
      verified: {
        feesReceivedUsd: { value: null, status: "unavailable" },
        native: { feesReceived: [{ unit: "SOL" }] },
      },
      // Biaya launch terukur devnet tidak ditampilkan sebagai angka mainnet.
      platform: { launchCostPaidByMasterWalletSol: { value: null } },
    });
    const rows = (transparency as unknown as { perToken: Array<{ tokenMint: string }> }).perToken;
    expect(rows.find((r) => r.tokenMint === mint)).toMatchObject({
      feesReceivedUsd: null,
      buybackUsd: null,
      reserveUsd: null,
      feesReceivedNative: "1",
      buybackNative: "0.8",
      reserveNative: "0.2",
    });
    expect(token).toMatchObject({
      priceUsd: { value: null },
      marketCapUsd: { value: null },
      liquidityUsd: { value: null },
    });
  });

  it("/api/pairs tidak mengirim target USD devnet", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/pairs" });
    for (const p of res.json().data.pairs as Array<Record<string, unknown>>) {
      expect(p.curveStartUsd).toBeNull();
      expect(p.curveGraduationUsd).toBeNull();
    }
  });

  it("harga terverifikasi mengisi USD (estimasi); begitu tidak terverifikasi kembali n/a", async () => {
    const mint = await seed();
    await ctx.db.tokenMarket.create({
      data: {
        tokenMint: mint,
        route: "launchlab",
        launchPool: newWallet().address,
        priceQuote: "0.000001",
        supplyRaw: "1000000000000000",
        curveRaisedRaw: "0",
        curveTargetRaw: "85000000000",
        curveStatus: 0,
        liquidityQuoteRaw: "2000000000",
        indexedAt: new Date(),
      },
    });
    snapshot = VERIFIED;
    const [token, transparency, stats] = await Promise.all([
      get(`/api/tokens/${mint}`),
      get("/api/transparency"),
      get("/api/stats"),
    ]);
    const usd = { status: "estimated", source: "price_feed" };
    expect(token).toMatchObject({
      // 1 miliar token × 0,000001 SOL × $100
      marketCapUsd: { value: "100000", ...usd },
      // 2 SOL × $100
      liquidityUsd: { value: "200", ...usd },
      priceUsd: { value: "0.0001", ...usd },
    });
    const noMock = JSON.stringify([token, transparency, stats]);
    expect(noMock).not.toContain('"source":"mock"');
    // Jumlah native tetap "verified"; setara USD-nya estimasi. Ledger append-only: cek baris token ini.
    expect(transparency).toMatchObject({
      verified: {
        feesReceivedUsd: usd,
        native: { feesReceived: [{ unit: "SOL", status: "verified" }] },
      },
    });
    const rows = (transparency as unknown as { perToken: Array<Record<string, unknown>> }).perToken;
    expect(rows.find((r) => r.tokenMint === mint)).toMatchObject({
      feesReceivedUsd: "100",
      feesReceivedNative: "1",
    });
    // Riwayat tidak dinilai dengan harga hari ini.
    const trades = (token as unknown as { recentTrades: Array<{ priceUsd: string | null }> })
      .recentTrades;
    expect(trades.every((t) => t.priceUsd === null)).toBe(true);

    snapshot = priceAt(100, 110); // selisih lewat batas
    const after = await get(`/api/tokens/${mint}`);
    expect(after).toMatchObject({
      marketCapUsd: { value: null, status: "unavailable" },
      liquidityUsd: { value: null, status: "unavailable" },
    });
  });

  it("/api/pairs mengisi raise setara USD hanya saat harga terverifikasi", async () => {
    const read = async () =>
      (
        (await ctx.app.inject({ method: "GET", url: "/api/pairs" })).json().data.pairs as Array<{
          curveGraduationUsd: string | null;
          curveGraduation: string;
        }>
      )[0]!;
    expect((await read()).curveGraduationUsd).toBeNull();
    snapshot = VERIFIED;
    const p = await read();
    expect(Number(p.curveGraduationUsd)).toBeCloseTo(Number(p.curveGraduation) * 100, 1);
  });

  it("/api/price/sol: status, batas, dan kode alasan tanpa pesan error mentah", async () => {
    const read = async () => get("/api/price/sol") as unknown as Record<string, unknown>;
    expect(await read()).toMatchObject({
      status: "unverified",
      usd: null,
      issues: ["jupiter_unreadable"],
      maxAgeSeconds: SOL_PRICE_CONFIG.maxAgeSeconds,
    });
    expect(JSON.stringify(await read())).not.toContain("HTTP 503");
    snapshot = VERIFIED;
    expect(await read()).toMatchObject({ status: "verified", usd: "100", issues: [] });
  });

  it("alert harga tampil di /api/health/status selama tidak terverifikasi", async () => {
    const codes = async () =>
      (
        (await ctx.app.inject({ method: "GET", url: "/api/health/status" })).json() as {
          alerts: Array<{ code: string }>;
        }
      ).alerts.map((a) => a.code);
    expect(await codes()).toContain("sol_price_unverified");
    snapshot = VERIFIED;
    expect(await codes()).not.toContain("sol_price_unverified");
  });

  it("filter top-reserves tetap berisi walau USD n/a (diurutkan lewat angka native)", async () => {
    const mint = await seed();
    await ctx.db.reserveLedger.create({
      data: {
        tokenMint: mint,
        assetMint: WSOL,
        entryType: "contribution",
        amount: "200000000",
        txSignature: `sig-${mint}-reserve`,
      },
    });
    const list = await get("/api/tokens?filter=top-reserves");
    const items = (list as unknown as { items: Array<Record<string, { value: string | null }>> })
      .items;
    const balance = (await get(`/api/tokens/${mint}`)) as unknown as {
      reserveBalanceQuote: { value: string };
    };
    if (Number(balance.reserveBalanceQuote.value) > 0) {
      expect(items.map((t) => t.mint)).toContain(mint);
      expect(items[0]!.reserveBalanceUsd!.value).toBeNull();
    }
  });

  describe("pair selain SOL", () => {
    const QUOTE = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
    const CONFIG = "8gj14w8vkNZjJTPak6e96Uf1sY438WKheH4s5dHyxiRw";
    const pairs = () => ctx.stonkfun.pairs;
    const usdc = () => pairsFor("devnet").find((p) => p.id === "usdc")!;

    async function seedQuote() {
      await saveQuoteAsset(ctx.db, "mainnet-beta", {
        mint: QUOTE,
        symbol: "SPYX",
        name: "SP500",
        decimals: 8,
        raiseRaw: "1054878163",
      });
      const mint = newWallet().address;
      const user = await ctx.db.user.create({ data: { wallet: newWallet().address } });
      await ctx.db.token.create({
        data: {
          name: "Spy",
          ticker: "SPYC",
          tickerNormalized: "spyc",
          mint,
          quoteMint: QUOTE,
          quoteConfigId: CONFIG,
          creatorUserId: user.id,
          launchStatus: "live",
        },
      });
      await ctx.db.tokenMarket.create({
        data: {
          tokenMint: mint,
          route: "launchlab",
          launchPool: mint,
          priceQuote: "0.00000001",
          supplyRaw: "1000000000000000",
          curveRaisedRaw: "100000000",
          curveTargetRaw: "1054878163",
          liquidityQuoteRaw: "100000000",
          curveStatus: 0,
          indexedAt: new Date(),
        },
      });
      return mint;
    }

    const oneToken = async (mint: string) =>
      (await ctx.app.inject({ method: "GET", url: `/api/tokens/${mint}` })).json().data;

    it("/api/pairs meneruskan semua pair adapter dengan kategori & mint", async () => {
      const res = await ctx.app.inject({ method: "GET", url: "/api/pairs" });
      const list = res.json().data.pairs as Array<{ id: string; mint: string; warnings: string[] }>;
      expect(list.some((p) => p.id === "usdc")).toBe(true);
      expect(list.length).toBe((await ctx.stonkfun.listPairs()).pairs.length);
      expect(list[0]!.warnings).toEqual([]);
    });

    it("/api/pairs/summary menghitung per kategori tanpa daftar penuh", async () => {
      const before = pairs().length;
      pairs().push({
        ...pairs()[0]!,
        id: "sf-custom",
        category: "custom",
        categoryLabel: "Custom",
        supported: false,
        launchLabReady: false,
      });
      const res = await ctx.app.inject({ method: "GET", url: "/api/pairs/summary" });
      pairs().length = before;
      const d = res.json().data;
      expect(d.pairs).toBeUndefined();
      expect(d.total).toBe(before + 1);
      expect(d.categories).toContainEqual({
        category: "custom",
        label: "Custom",
        total: 1,
        available: 0,
      });
    });

    it("/api/pairs/:id: pair ada, tak ada = 404, USD n/a tanpa harga terverifikasi", async () => {
      snapshot = VERIFIED;
      const res = await ctx.app.inject({ method: "GET", url: `/api/pairs/${usdc().id}` });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({
        id: "usdc",
        quoteUsd: null,
        curveGraduationUsd: null,
      });
      quoteSnapshots[usdc().mint] = { ...VERIFIED, usd: 0.5 };
      const priced = await ctx.app.inject({ method: "GET", url: `/api/pairs/${usdc().id}` });
      expect(priced.json().data.quoteUsd).toBe("0.5");
      const missing = await ctx.app.inject({ method: "GET", url: "/api/pairs/tidak-ada" });
      expect(missing.statusCode).toBe(404);
    });

    it("/api/pairs/:id dibatasi per IP", async () => {
      const ip = nextIp();
      const statuses: number[] = [];
      for (let i = 0; i < 32; i++) {
        const r = await ctx.app.inject({
          method: "GET",
          url: `/api/pairs/${usdc().id}`,
          remoteAddress: ip,
        });
        statuses.push(r.statusCode);
      }
      expect(statuses).toContain(429);
    });

    it("token lama: simbol & desimal dari katalog; USD n/a tanpa harga, angka native tetap benar", async () => {
      snapshot = VERIFIED;
      const mint = await seedQuote();
      const t = await oneToken(mint);
      expect(t).toMatchObject({ quoteSymbol: "SPYX", quoteMint: QUOTE, quoteDecimals: 8 });
      // 1 token mentah 1e15 / 1e6 × harga 1e-8 = 10 SPYX
      expect(t.marketCapQuote).toMatchObject({ value: "10", unit: "SPYX" });
      expect(t.marketCapUsd).toMatchObject({ value: null, status: "unavailable" });
      expect(t.priceUsd.value).toBeNull();
    });

    it("harga quote terverifikasi: USD memakai harga quote itu, bukan harga SOL", async () => {
      snapshot = VERIFIED;
      quoteSnapshots[QUOTE] = { ...VERIFIED, usd: 760 };
      const mint = await seedQuote();
      const t = await oneToken(mint);
      expect(t.marketCapUsd).toMatchObject({ value: "7600", status: "estimated" });
    });

    it("harga SOL tidak terverifikasi: semua USD n/a walau harga quote ada", async () => {
      quoteSnapshots[QUOTE] = { ...VERIFIED, usd: 760 };
      const mint = await seedQuote();
      expect((await oneToken(mint)).marketCapUsd.value).toBeNull();
    });

    it("quote belum dikenal: tidak menebak desimal, angka native tidak tersedia", async () => {
      snapshot = VERIFIED;
      const mint = newWallet().address;
      const user = await ctx.db.user.create({ data: { wallet: newWallet().address } });
      await ctx.db.token.create({
        data: {
          name: "Asing",
          ticker: "ASING",
          tickerNormalized: "asing",
          mint,
          quoteMint: newWallet().address,
          quoteConfigId: "Cfg",
          creatorUserId: user.id,
          launchStatus: "live",
        },
      });
      await ctx.db.tokenMarket.create({
        data: {
          tokenMint: mint,
          route: "launchlab",
          launchPool: mint,
          priceQuote: "0.00000001",
          supplyRaw: "1000000000000000",
          curveRaisedRaw: "1",
          curveTargetRaw: "2",
          liquidityQuoteRaw: "1",
          curveStatus: 0,
          indexedAt: new Date(),
        },
      });
      const t = await oneToken(mint);
      expect(t).toMatchObject({ quoteSymbol: "?", quoteDecimals: null });
      expect(t.marketCapQuote.value).toBeNull();
    });

    it("total lintas pair n/a bila satu quote tanpa harga; jumlah native tetap per aset", async () => {
      snapshot = VERIFIED;
      const mint = await seedQuote();
      await ctx.db.tradeReceipt.create({
        data: {
          signature: `vol-${mint}`,
          tokenMint: mint,
          wallet: newWallet().address,
          side: "buy",
          route: "launchlab",
          quoteMint: QUOTE,
          amountToken: "1000000",
          amountQuote: "100000000",
          creatorFee: "0",
          slot: 1n,
          priceQuote: "0.00000001",
          recordedBy: "indexer",
        },
      });
      const stats = async () =>
        (await ctx.app.inject({ method: "GET", url: "/api/stats" })).json().data;
      const before = await stats();
      expect(before.tradingVolumeUsd.value).toBeNull();
      expect(before.native.tradingVolume).toContainEqual(
        expect.objectContaining({ value: "1", unit: "SPYX" }),
      );
      quoteSnapshots[QUOTE] = { ...VERIFIED, usd: 760 };
      expect((await stats()).tradingVolumeUsd.value).toBe("760");
    });

    it("/api/tokens?pair=sf-<mint> memfilter per mint; /api/pairs/used hanya quote terpakai", async () => {
      const mint = await seedQuote();
      const res = await ctx.app.inject({ method: "GET", url: `/api/tokens?pair=sf-${QUOTE}` });
      expect(res.json().data.items.map((t: { mint: string }) => t.mint)).toEqual([mint]);
      const none = await ctx.app.inject({
        method: "GET",
        url: `/api/tokens?pair=sf-${newWallet().address}`,
      });
      expect(none.json().data.items).toEqual([]);
      const used = await ctx.app.inject({ method: "GET", url: "/api/pairs/used" });
      expect(used.json().data).toEqual([
        { id: `sf-${QUOTE}`, symbol: "SPYX", name: "SP500", mint: QUOTE },
      ]);
    });

    it("trade: quote di katalog diterima; quote tak dikenal ditolak", async () => {
      const mint = newWallet().address;
      const user = await ctx.db.user.create({ data: { wallet: newWallet().address } });
      await ctx.db.token.create({
        data: {
          name: "Usd",
          ticker: "USDX",
          tickerNormalized: "usdx",
          mint,
          quoteMint: newWallet().address,
          quoteConfigId: "CfgAsing",
          creatorUserId: user.id,
          launchStatus: "live",
        },
      });
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/trade/quote",
        remoteAddress: nextIp(),
        payload: { mint, side: "buy", amountIn: "1000000", slippageBps: 100 },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("route_unavailable");
    });
  });
});

describe("devnet tidak berubah oleh aturan mainnet", () => {
  it("semua pair tetap ditawarkan; USD tetap MOCK; status harga = assumed", async () => {
    const ctx = await makeApp();
    try {
      const pairs = (await ctx.app.inject({ method: "GET", url: "/api/pairs" })).json().data
        .pairs as Array<{ id: string; curveGraduationUsd: string | null }>;
      expect(pairs.map((p) => p.id)).toEqual(expect.arrayContaining(["sol", "usdc", "ray"]));
      expect(pairs[0]!.curveGraduationUsd).toBe("12000");
      const price = (await ctx.app.inject({ method: "GET", url: "/api/price/sol" })).json().data;
      expect(price).toMatchObject({ status: "assumed", usd: null });
      const stats = (await ctx.app.inject({ method: "GET", url: "/api/stats" })).json().data;
      expect(stats.tradingVolumeUsd.source).toBe("mock");
    } finally {
      await ctx.app.close();
    }
  });
});
