import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  devLinkX,
  launchBody,
  makeApp,
  newWallet,
  nextIp,
  resetDb,
  walletLogin,
} from "./test-helpers";

type Ctx = Awaited<ReturnType<typeof makeApp>>;
let ctx: Ctx;

beforeAll(async () => {
  ctx = await makeApp();
}, 120_000);
afterAll(() => ctx.app.close());
beforeEach(() => resetDb(ctx.db));

const WSOL = "So11111111111111111111111111111111111111112";

async function seedLiveToken(ticker: string, mint: string, graduated = false) {
  const user = await ctx.db.user.create({ data: { wallet: newWallet().address } });
  return ctx.db.token.create({
    data: {
      name: `${ticker} coin`,
      ticker,
      tickerNormalized: ticker.toLowerCase(),
      mint,
      quoteMint: WSOL,
      quoteConfigId: "7ZR4zD7PYfY2XxoG1Gxcy2EgEeGYrpxrwzPuwdUBssEt",
      creatorUserId: user.id,
      launchStatus: "live",
      graduatedAt: graduated ? new Date() : null,
    },
  });
}

/** Mint acak = public key 32 byte (unik per test karena ledger append-only tidak dikosongkan). */
function fakeMint() {
  return newWallet().address;
}

describe("GET /api/tokens/:mint/candles", () => {
  const MIN = 60;
  // Awal menit yang utuh, jadi pembagian candle tidak bergantung jam saat test berjalan.
  const T0 = 1_790_000_100;

  async function trade(
    mint: string,
    slot: number,
    price: string | null,
    seconds: number,
    amountQuote = "1000000000",
  ) {
    await ctx.db.tradeReceipt.create({
      data: {
        signature: `candle-${slot}-${mint}`,
        tokenMint: mint,
        wallet: newWallet().address,
        side: "buy",
        route: "launchlab",
        quoteMint: WSOL,
        amountToken: "1000000",
        amountQuote,
        creatorFee: "0",
        slot: BigInt(slot),
        priceQuote: price,
        recordedBy: "indexer",
        blockTime: new Date(seconds * 1000),
      },
    });
  }

  const candles = async (mint: string, query = "") =>
    ctx.app.inject({ method: "GET", url: `/api/tokens/${mint}/candles${query}` });

  it("OHLC per periode; harga buka = harga tutup candle sebelumnya", async () => {
    const mint = fakeMint();
    await seedLiveToken("CDL", mint);
    await trade(mint, 1, "0.0000001", T0 + 5);
    await trade(mint, 2, "0.0000003", T0 + 10);
    await trade(mint, 3, "0.0000002", T0 + 20);
    await trade(mint, 4, "0.0000005", T0 + 5 * MIN, "500000000");
    await trade(mint, 5, null, T0 + 5 * MIN + 1);

    const res = await candles(mint, "?interval=1m");
    expect(res.statusCode).toBe(200);
    expect(Number(res.json().data.quoteUsd)).toBeGreaterThan(0);
    expect(res.json().data).toMatchObject({
      interval: "1m",
      candles: [
        {
          time: T0 - (T0 % MIN),
          open: "0.0000001",
          high: "0.0000003",
          low: "0.0000001",
          close: "0.0000002",
          volumeQuote: "3",
          trades: 3,
        },
        {
          time: T0 + 5 * MIN - (T0 % MIN),
          open: "0.0000002",
          high: "0.0000005",
          low: "0.0000002",
          close: "0.0000005",
          volumeQuote: "0.5",
          trades: 1,
        },
      ],
    });
  });

  it("interval lebih besar menggabungkan trade; default 5m", async () => {
    const mint = fakeMint();
    await seedLiveToken("CDLH", mint);
    await trade(mint, 1, "0.0000001", T0 + 5);
    await trade(mint, 2, "0.0000002", T0 + 3 * MIN);
    const hour = (await candles(mint, "?interval=1h")).json().data;
    expect(hour.candles).toHaveLength(1);
    expect(hour.candles[0]).toMatchObject({ close: "0.0000002", trades: 2 });
    expect((await candles(mint)).json().data.interval).toBe("5m");
  });

  it("tanpa trade → kosong; interval salah & token tidak dikenal ditolak", async () => {
    const mint = fakeMint();
    await seedLiveToken("CDLE", mint);
    expect((await candles(mint)).json().data.candles).toEqual([]);
    expect((await candles(mint, "?interval=2m")).statusCode).toBe(400);
    expect((await candles(fakeMint())).statusCode).toBe(404);
  });
});

describe("GET /api/tokens & /api/tokens/:mint & ledger", () => {
  it("daftar hanya token live; data pasar bertanda mock, data ledger dari indexer", async () => {
    const mint = fakeMint();
    const seeded = await seedLiveToken("LIVE", mint);
    const s = await walletLogin(ctx.app);
    await ctx.app.inject({
      method: "POST",
      url: "/api/launch",
      headers: { cookie: s.cookie, "idempotency-key": randomUUID() },
      payload: launchBody({ ticker: "QUEUED" }),
      remoteAddress: s.ip,
    });

    const res = await ctx.app.inject({ method: "GET", url: "/api/tokens" });
    const items = res.json().data.items as Array<Record<string, unknown>>;
    expect(items.map((t) => t.ticker)).toEqual(["LIVE"]);
    expect(items[0]).toMatchObject({
      mint,
      quoteSymbol: "SOL",
      creatorWallet: (await ctx.db.user.findUniqueOrThrow({ where: { id: seeded.creatorUserId } }))
        .wallet,
      creatorXHandle: null,
      verifiedCreator: false,
      launchStatus: "live",
      priceUsd: { source: "mock" },
      burnedSupplyPct: { source: "indexer", status: "verified", value: "0" },
    });
  });

  it("koin yang diluncurkan dengan akun X tertaut tampil sebagai verified creator", async () => {
    const s = await walletLogin(ctx.app);
    await devLinkX(ctx.app, s, "maker");
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/launch",
      headers: { cookie: s.cookie, "idempotency-key": randomUUID() },
      payload: launchBody({ ticker: "VERI" }),
      remoteAddress: s.ip,
    });
    const mint = fakeMint();
    // Tahap 4 yang akan mengisi mint & status live; di sini disimulasikan.
    await ctx.db.token.update({
      where: { id: res.json().tokenId },
      data: { mint, launchStatus: "live" },
    });
    const detail = await ctx.app.inject({ method: "GET", url: `/api/tokens/${mint}` });
    expect(detail.json().data).toMatchObject({
      creatorWallet: s.wallet.address,
      creatorXHandle: "@maker",
      verifiedCreator: true,
    });
  });

  it("filter graduated & pair, pagination cursor", async () => {
    await seedLiveToken("GRAD", fakeMint(), true);
    for (const t of ["AAA", "BBB", "CCC"]) await seedLiveToken(t, fakeMint());
    const grad = await ctx.app.inject({ method: "GET", url: "/api/tokens?filter=graduated" });
    expect(grad.json().data.items.map((t: { ticker: string }) => t.ticker)).toEqual(["GRAD"]);
    expect(grad.json().data.items[0].curveProgressPct).toMatchObject({
      value: "100",
      source: "indexer",
    });

    const usdc = await ctx.app.inject({ method: "GET", url: "/api/tokens?pair=usdc" });
    expect(usdc.json().data.items).toHaveLength(0);

    const p1 = await ctx.app.inject({ method: "GET", url: "/api/tokens?limit=3" });
    expect(p1.json().data.items).toHaveLength(3);
    const cursor = p1.json().data.nextCursor;
    const p2 = await ctx.app.inject({ method: "GET", url: `/api/tokens?limit=3&cursor=${cursor}` });
    expect(p2.json().data.items).toHaveLength(1);
    expect(p2.json().data.nextCursor).toBeNull();

    const bad = await ctx.app.inject({ method: "GET", url: "/api/tokens?filter=nope" });
    expect(bad.statusCode).toBe(400);
  });

  it("detail + ledger: nominal bigint dikonversi tepat, burn % dari ledger", async () => {
    const mint = fakeMint();
    await seedLiveToken("LEDG", mint);
    await ctx.db.feeLedger.createMany({
      data: [
        {
          sourceSignature: `s1-${mint}`,
          tokenMint: mint,
          amount: "1102540",
          assetMint: WSOL,
          entryType: "received",
          source: "creator_fee",
          attribution: "verified",
        },
        {
          sourceSignature: `s2-${mint}`,
          tokenMint: mint,
          amount: "3000000",
          assetMint: WSOL,
          entryType: "received",
          source: "creator_fee",
          attribution: "verified",
        },
      ],
    });
    await ctx.db.burnLedger.create({
      data: {
        tokenMint: mint,
        amountBurned: "18521402319433",
        amountSpent: "20000000",
        assetMint: WSOL,
        buybackSignature: `bb-${mint}`,
        burnSignature: `burn-${mint}`,
      },
    });

    const detail = await ctx.app.inject({ method: "GET", url: `/api/tokens/${mint}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data).toMatchObject({
      ticker: "LEDG",
      totalSupply: "1000000000",
      burnedSupplyPct: { value: "1.8521", status: "verified" },
      // Belum diindeks → unavailable (bukan angka contoh).
      holders: { status: "unavailable", value: null },
      priceQuote: { status: "unavailable" },
    });

    const ledger = await ctx.app.inject({ method: "GET", url: `/api/tokens/${mint}/ledger` });
    const data = ledger.json().data;
    expect(data.totals.feesReceived).toMatchObject({
      value: "0.00410254",
      unit: "SOL",
      status: "verified",
    });
    expect(data.totals.burnedTokens.value).toBe("18521402.319433");
    expect(data.burns[0]).toMatchObject({ amountSpent: "0.02", assetSymbol: "SOL" });
    expect(data.fees).toHaveLength(2);
    expect(data.reserveState).toMatchObject({ mode: "accumulating", balance: { value: "0" } });
  });

  it("404 untuk mint tak dikenal / format salah", async () => {
    for (const mint of [fakeMint(), "not-a-mint"]) {
      const res = await ctx.app.inject({ method: "GET", url: `/api/tokens/${mint}` });
      expect(res.statusCode).toBe(404);
    }
  });

  it("data pasar dari indexer: native verified, USD MOCK, delayed bila snapshot tertinggal", async () => {
    const mint = fakeMint();
    const stale = fakeMint();
    await seedLiveToken("MKT", mint);
    await seedLiveToken("OLD", stale);
    const now = Date.now();
    const snapshot = (tokenMint: string, indexedAt: Date) => ({
      tokenMint,
      route: "launchlab" as const,
      launchPool: `pool-${tokenMint}`,
      curveStatus: 0,
      priceQuote: "0.000000000483325",
      supplyRaw: "1000000000000000",
      curveRaisedRaw: "60000000",
      curveTargetRaw: "100000000",
      liquidityQuoteRaw: "60000000",
      holders: 3,
      holdersAt: indexedAt,
      indexedAt,
    });
    await ctx.db.tokenMarket.createMany({
      data: [snapshot(mint, new Date(now - 5_000)), snapshot(stale, new Date(now - 3_600_000))],
    });
    const receipt = (i: number, amountQuote: string, price: string, at: number) => ({
      signature: `mkt-${i}-${mint}`,
      tokenMint: mint,
      wallet: newWallet().address,
      side: "buy",
      route: "launchlab",
      quoteMint: WSOL,
      amountToken: "1000000",
      amountQuote,
      creatorFee: "0",
      slot: BigInt(i),
      priceQuote: price,
      recordedBy: "indexer",
      createdAt: new Date(at),
    });
    await ctx.db.tradeReceipt.createMany({
      data: [
        receipt(1, "1000000000", "0.0000000004", now - 2 * 86_400_000),
        receipt(2, "10000000", "0.00000000045", now - 3_600_000),
        receipt(3, "5000000", "0.000000000483325", now - 60_000),
      ],
    });

    const res = await ctx.app.inject({ method: "GET", url: `/api/tokens/${mint}` });
    const d = res.json().data;
    expect(d.priceQuote).toMatchObject({
      value: "0.000000000483325",
      unit: "SOL",
      status: "verified",
      source: "indexer",
    });
    expect(d.marketCapQuote.value).toBe("0.483325");
    expect(d.volume24hQuote.value).toBe("0.015");
    expect(d.volumeTotalQuote.value).toBe("1.015");
    expect(d.priceChange24hPct.value).toBe("20.8");
    expect(d.curveProgressPct.value).toBe("60");
    expect(d.curveRemainingQuote.value).toBe("0.04");
    expect(d.holders).toMatchObject({ value: "3", status: "verified" });
    expect(d.priceUsd.source).toBe("mock"); // konversi USD = harga asumsi pair
    expect(d.chart.map((p: { priceQuote: string }) => p.priceQuote)).toEqual([
      "0.0000000004",
      "0.00000000045",
      "0.000000000483325",
      "0.000000000483325",
    ]);
    expect(d.recentTrades).toHaveLength(3);

    const old = (await ctx.app.inject({ method: "GET", url: `/api/tokens/${stale}` })).json().data;
    expect(old.priceQuote.status).toBe("delayed");

    const trending = await ctx.app.inject({ method: "GET", url: "/api/tokens?filter=trending" });
    expect(trending.json().data.items.map((t: { ticker: string }) => t.ticker)).toEqual(["MKT"]);
    const graduating = await ctx.app.inject({
      method: "GET",
      url: "/api/tokens?filter=graduating",
    });
    expect(graduating.json().data.items).toHaveLength(2);

    const stats = (await ctx.app.inject({ method: "GET", url: "/api/stats" })).json().data;
    expect(stats.native.tradingVolume).toEqual([
      expect.objectContaining({ value: "1.015", unit: "SOL", source: "indexer" }),
    ]);
    expect(stats.tradingVolumeUsd.source).toBe("mock");
    expect(stats.indexerUpdatedAt).not.toBeNull();
  });

  it("activity & transparency membaca ledger", async () => {
    const mint = fakeMint();
    await seedLiveToken("TRNS", mint);
    await ctx.db.feeLedger.create({
      data: {
        sourceSignature: `t-${mint}`,
        tokenMint: mint,
        amount: "500000",
        assetMint: WSOL,
        entryType: "received",
        source: "creator_fee",
        attribution: "verified",
      },
    });
    const activity = await ctx.app.inject({ method: "GET", url: "/api/activity?limit=50" });
    expect(activity.json().data.some((a: { tokenMint: string }) => a.tokenMint === mint)).toBe(
      true,
    );
    const tr = await ctx.app.inject({ method: "GET", url: "/api/transparency" });
    const t = tr.json().data;
    expect(t.platform.tokensLaunched).toMatchObject({ value: "1", source: "indexer" });
    expect(t.verified.feesReceivedUsd.source).toBe("mock"); // USD = harga asumsi
    expect(t.perToken.map((r: { ticker: string }) => r.ticker)).toContain("TRNS");
  });
});

// ------------------------------------------------------------------- gambar

const SVG_A = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">
  <rect width="400" height="400" fill="#f4e9d0"/>
  <circle cx="200" cy="170" r="110" fill="#e0592a"/>
  <rect x="120" y="290" width="160" height="60" rx="20" fill="#1d3557"/>
  <circle cx="160" cy="150" r="18" fill="#fff"/><circle cx="240" cy="150" r="18" fill="#fff"/>
</svg>`;
const SVG_B = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">
  <rect width="400" height="400" fill="#0b132b"/>
  <polygon points="200,30 370,370 30,370" fill="#5bc0be"/>
  <rect x="0" y="0" width="120" height="120" fill="#ffd166"/>
</svg>`;

async function upload(session: { cookie: string; ip: string }, image: Buffer, type = "image/png") {
  return ctx.app.inject({
    method: "POST",
    url: "/api/uploads/image",
    headers: { cookie: session.cookie, "content-type": type },
    payload: image,
    remoteAddress: session.ip,
  });
}

describe("upload gambar + perceptual hash", () => {
  it("salinan resize / recolor ringan / crop kecil terdeteksi; gambar lain tidak", async () => {
    const original = await sharp(Buffer.from(SVG_A)).png().toBuffer();
    const owner = await walletLogin(ctx.app);
    const up = await upload(owner, original);
    expect(up.statusCode).toBe(201);
    const { imageRef, imageUrl } = up.json();
    expect(imageUrl).toBe(`/api/uploads/${imageRef}.webp`);
    const launched = await ctx.app.inject({
      method: "POST",
      url: "/api/launch",
      headers: { cookie: owner.cookie, "idempotency-key": randomUUID() },
      payload: launchBody({ ticker: "ARTY", imageRef }),
      remoteAddress: owner.ip,
    });
    expect(launched.statusCode).toBe(201);

    const copies = {
      resized: await sharp(original).resize(180, 180).jpeg({ quality: 70 }).toBuffer(),
      recolored: await sharp(original)
        .modulate({ brightness: 1.1, saturation: 0.8, hue: 15 })
        .png()
        .toBuffer(),
      cropped: await sharp(original)
        .extract({ left: 12, top: 12, width: 376, height: 376 })
        .png()
        .toBuffer(),
    };
    const copier = await walletLogin(ctx.app);
    for (const [kind, buf] of Object.entries(copies)) {
      const res = await upload(copier, buf, kind === "resized" ? "image/jpeg" : "image/png");
      expect(res.statusCode, kind).toBe(201);
      const v = await ctx.app.inject({
        method: "POST",
        url: "/api/launch/validate",
        headers: { cookie: copier.cookie },
        payload: launchBody({ ticker: "OTHER", imageRef: res.json().imageRef }),
        remoteAddress: copier.ip,
      });
      // Spec §7: gambar hampir identik = indikator risiko (dengan alasan), bukan blokir tunggal.
      expect(
        v.json().risk.indicators.map((r: { code: string }) => r.code),
        kind,
      ).toContain("image_similar");
    }

    const different = await upload(copier, await sharp(Buffer.from(SVG_B)).png().toBuffer());
    const ok = await ctx.app.inject({
      method: "POST",
      url: "/api/launch/validate",
      headers: { cookie: copier.cookie },
      payload: launchBody({ ticker: "OTHER", imageRef: different.json().imageRef }),
      remoteAddress: copier.ip,
    });
    expect(ok.json().result).toBe("ok");

    const served = await ctx.app.inject({ method: "GET", url: imageUrl });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toBe("image/webp");
  });

  it("menolak upload tanpa login, bukan gambar, atau terlalu kecil", async () => {
    const anon = await ctx.app.inject({
      method: "POST",
      url: "/api/uploads/image",
      headers: { "content-type": "image/png" },
      payload: Buffer.from("x"),
      remoteAddress: nextIp(),
    });
    expect(anon.statusCode).toBe(401);
    const s = await walletLogin(ctx.app);
    expect((await upload(s, Buffer.from("not an image"))).statusCode).toBe(422);
    const tiny = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#fff" } })
      .png()
      .toBuffer();
    expect((await upload(s, tiny)).json().error.code).toBe("image_too_small");
  });
});
