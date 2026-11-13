import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ECONOMIC_CONFIG, perQuote, SOL_REFERENCE_RAISE_RAW } from "./economic-config";
import {
  pairAccessFrom,
  pairForMint,
  pairForToken,
  pairsFor,
  rememberQuoteAssets,
  WSOL_MINT,
} from "./pairs";
import { evaluateReserveDeployment, RESERVE_CONFIG } from "./reserve-config";
import {
  evaluateSolPrice,
  JupiterPriceBatch,
  JupiterPriceSource,
  parseJupiterPrice,
  parseStonkFunPrices,
  parseStonkFunQuotePrice,
  QuotePriceBook,
  SOL_PRICE_CONFIG,
  solPriceAlert,
  SolPriceOracle,
  solPriceSettingsFrom,
  usdRatesFor,
  type PriceObservation,
  type SourceReading,
} from "./sol-price";
import { createSolPriceOracle, MainnetStonkFunAdapter, type FetchLike } from "./stonkfun-api";

const FIXTURE = JSON.parse(
  readFileSync(
    new URL("./__fixtures__/stonkfun/pricing-sol-mainnet-2026-10-31.json", import.meta.url),
    "utf8",
  ),
) as { data: { prices: { solUsd: number; observedAt: string } } };

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const cfg = SOL_PRICE_CONFIG;
const obs = (usd: number, ageSeconds = 30): SourceReading => ({
  observation: { usd, observedAtMs: NOW - ageSeconds * 1000 },
  error: null,
});
const down = (error = "HTTP 503"): SourceReading => ({ observation: null, error });

describe("parsing respons", () => {
  it("fixture pricing asli StonkFun", () => {
    const o = parseStonkFunPrices(FIXTURE.data.prices);
    expect(o.usd).toBeCloseTo(95.8424858316876);
    expect(new Date(o.observedAtMs).toISOString()).toBe("2026-10-31T12:35:43.178Z");
  });

  it.each([
    ["blok prices absen", undefined],
    ["null", null],
    ["solUsd string", { solUsd: "95", observedAt: "2026-10-31T12:35:43.178Z" }],
    ["solUsd nol", { solUsd: 0, observedAt: "2026-10-31T12:35:43.178Z" }],
    ["solUsd negatif", { solUsd: -1, observedAt: "2026-10-31T12:35:43.178Z" }],
    ["tanpa observedAt", { solUsd: 95 }],
    ["observedAt bukan waktu", { solUsd: 95, observedAt: "kemarin" }],
  ])("StonkFun ditolak: %s", (_n, prices) => {
    expect(() => parseStonkFunPrices(prices)).toThrow();
  });

  it("bentuk asli Jupiter: `createdAt` (waktu token dibuat) tidak dipakai sebagai waktu harga", () => {
    const json = {
      [WSOL_MINT]: { createdAt: "2024-06-05T08:55:25.527Z", usdPrice: 94.69, blockId: 464099225 },
    };
    expect(parseJupiterPrice(json, WSOL_MINT, NOW)).toEqual({ usd: 94.69, observedAtMs: NOW });
  });

  it.each([
    ["mint lain", { Other: { usdPrice: 1 } }],
    ["harga nol", { [WSOL_MINT]: { usdPrice: 0 } }],
    ["harga bukan angka", { [WSOL_MINT]: { usdPrice: "94" } }],
    ["bukan objek", []],
  ])("Jupiter ditolak: %s", (_n, json) => {
    expect(() => parseJupiterPrice(json, WSOL_MINT, NOW)).toThrow();
  });
});

describe("evaluateSolPrice", () => {
  it("kedua sumber segar & sejalan → verified, harga StonkFun, umur = yang tertua", () => {
    const p = evaluateSolPrice(obs(95, 40), obs(95.1, 3), cfg, NOW);
    expect(p).toMatchObject({ status: "verified", usd: 95, ageSeconds: 40, issues: [] });
    expect(p.deviationBps).toBe(11);
    expect(p.observedAt).toBe(new Date(NOW - 40_000).toISOString());
  });

  it("umur tepat di batas masih boleh; lewat satu detik → unverified tanpa angka", () => {
    const edge = cfg.maxAgeSeconds;
    expect(evaluateSolPrice(obs(95, edge), obs(95), cfg, NOW).status).toBe("verified");
    const old = evaluateSolPrice(obs(95, edge + 1), obs(95), cfg, NOW);
    expect(old).toMatchObject({
      status: "unverified",
      usd: null,
      observedAt: null,
      ageSeconds: null,
      issues: ["stonkfun_stale"],
    });
    expect(evaluateSolPrice(obs(95), obs(95, edge + 1), cfg, NOW).issues).toEqual([
      "jupiter_stale",
    ]);
  });

  it("observedAt jauh di depan jam lokal tidak dipercaya; selisih jam kecil boleh", () => {
    const future = evaluateSolPrice(obs(95, -(cfg.maxFutureSkewSeconds + 1)), obs(95), cfg, NOW);
    expect(future.issues).toEqual(["stonkfun_future"]);
    expect(evaluateSolPrice(obs(95, -5), obs(95), cfg, NOW).status).toBe("verified");
  });

  it("selisih tepat di batas boleh; melewati batas → unverified, dua-duanya tetap terlapor", () => {
    expect(evaluateSolPrice(obs(100), obs(101.5), cfg, NOW)).toMatchObject({
      status: "verified",
      deviationBps: 150,
    });
    const far = evaluateSolPrice(obs(100), obs(101.6), cfg, NOW);
    expect(far).toMatchObject({
      status: "unverified",
      usd: null,
      deviationBps: 160,
      issues: ["deviation_too_large"],
    });
    expect(far.sources.jupiter.usd).toBe(101.6);
    // Arah sebaliknya sama.
    expect(evaluateSolPrice(obs(101.6), obs(100), cfg, NOW).issues).toEqual([
      "deviation_too_large",
    ]);
  });

  it("aturan satu sumber: StonkFun saja atau Jupiter saja TIDAK terverifikasi", () => {
    expect(evaluateSolPrice(obs(95), down(), cfg, NOW)).toMatchObject({
      status: "unverified",
      usd: null,
      issues: ["jupiter_unreadable"],
    });
    expect(evaluateSolPrice(down(), obs(95), cfg, NOW)).toMatchObject({
      status: "unverified",
      usd: null,
      issues: ["stonkfun_unreadable"],
    });
    expect(evaluateSolPrice(down(), down(), cfg, NOW).issues).toEqual([
      "stonkfun_unreadable",
      "jupiter_unreadable",
    ]);
  });

  it("gagal sesaat masih memakai bacaan terakhir yang belum tua; sesudah itu = tidak terbaca", () => {
    const blip = { ...obs(95, 100), error: "HTTP 503" };
    expect(evaluateSolPrice(obs(95), blip, cfg, NOW).status).toBe("verified");
    const long = { ...obs(95, cfg.maxAgeSeconds + 1), error: "HTTP 503" };
    expect(evaluateSolPrice(obs(95), long, cfg, NOW).issues).toEqual(["jupiter_unreadable"]);
  });

  it("alert menyebut alasannya dan akibatnya", () => {
    const a = solPriceAlert(evaluateSolPrice(obs(95), down(), cfg, NOW));
    expect(a).toMatchObject({ level: "warn", code: "sol_price_unverified" });
    expect(a.message).toContain("jupiter_unreadable");
    expect(a.message).toContain("deployment reserve ditahan");
    expect(solPriceAlert(null).code).toBe("sol_price_unverified");
  });
});

describe("SolPriceOracle", () => {
  function oracle(over: {
    a?: () => Promise<PriceObservation>;
    b?: () => Promise<PriceObservation>;
  }) {
    const clock = { t: NOW };
    const calls = { a: 0, b: 0 };
    const o = new SolPriceOracle({
      now: () => clock.t,
      stonkfun: () => {
        calls.a++;
        return over.a ? over.a() : Promise.resolve({ usd: 95, observedAtMs: clock.t - 30_000 });
      },
      jupiter: () => {
        calls.b++;
        return over.b ? over.b() : Promise.resolve({ usd: 95, observedAtMs: clock.t });
      },
    });
    return { o, clock, calls };
  }

  it("cache: banyak permintaan dalam satu jendela = satu pembacaan per sumber", async () => {
    const { o, clock, calls } = oracle({});
    await Promise.all([o.read(), o.read(), o.read()]);
    for (let i = 0; i < 50; i++) o.current();
    await o.read();
    expect(calls).toEqual({ a: 1, b: 1 });
    clock.t += cfg.refreshMs;
    await o.read();
    expect(calls).toEqual({ a: 2, b: 2 });
  });

  it("current() tidak menunggu jaringan: mula-mula unverified, bukan angka karangan", async () => {
    const { o } = oracle({});
    expect(o.current()).toMatchObject({ status: "unverified", usd: null });
    expect((await o.read()).status).toBe("verified");
  });

  it("satu sumber melempar: read tidak melempar; bacaan yang menua akhirnya unverified", async () => {
    let fail = false;
    const { o, clock } = oracle({
      b: () =>
        fail
          ? Promise.reject(new Error("HTTP 500"))
          : Promise.resolve({ usd: 95, observedAtMs: clock.t }),
    });
    expect((await o.read()).status).toBe("verified");
    fail = true;
    clock.t += cfg.refreshMs;
    const blip = await o.read();
    expect(blip.status).toBe("verified");
    expect(blip.sources.jupiter.error).toBe("HTTP 500");
    clock.t += (cfg.maxAgeSeconds + 1) * 1000;
    expect(await o.read()).toMatchObject({
      status: "unverified",
      usd: null,
      issues: ["jupiter_unreadable"],
    });
  });

  it("tanpa pembacaan baru, umur tetap dinilai ulang: harga lama tidak bertahan", async () => {
    const { o, clock } = oracle({ a: () => new Promise(() => undefined) });
    // StonkFun menggantung sejak awal: tidak pernah terbaca.
    void o.read();
    expect(o.current().status).toBe("unverified");
    clock.t += 3_600_000;
    expect(o.current()).toMatchObject({ status: "unverified", usd: null });
  });
});

describe("JupiterPriceSource", () => {
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  });

  it("GET ke /price/v3 dan menghormati Retry-After: tidak ada request sampai lewat", async () => {
    let t = NOW;
    const urls: string[] = [];
    let next = reply(429, {}, { "retry-after": "120" });
    const fetch: FetchLike = async (url, init) => {
      urls.push(`${init.method} ${url}`);
      return next;
    };
    const j = new JupiterPriceSource({ baseUrl: "https://j.test/", fetch, now: () => t });
    await expect(j.read()).rejects.toThrow("HTTP 429");
    await expect(j.read()).rejects.toThrow("Retry-After");
    expect(urls).toEqual([`GET https://j.test/price/v3?ids=${WSOL_MINT}`]);
    t += 120_000;
    next = reply(200, { [WSOL_MINT]: { usdPrice: 94.5 } });
    await expect(j.read()).resolves.toEqual({ usd: 94.5, observedAtMs: t });
    expect(urls).toHaveLength(2);
  });

  it("HTTP selain 200 dan JSON rusak → melempar (sumber dianggap gagal)", async () => {
    const j = (status: number, text: string) =>
      new JupiterPriceSource({
        fetch: async () => ({ status, headers: { get: () => null }, text: async () => text }),
      }).read();
    await expect(j(500, "{}")).rejects.toThrow("HTTP 500");
    await expect(j(200, "<html>")).rejects.toThrow();
  });
});

describe("harga dari adapter StonkFun", () => {
  const body = readFileSync(
    new URL("./__fixtures__/stonkfun/pricing-sol-mainnet-2026-10-31.json", import.meta.url),
    "utf8",
  );

  function setup(enabled: boolean, res: () => { status: number; text: string; retry?: string }) {
    const calls: string[] = [];
    let t = NOW;
    const a = new MainnetStonkFunAdapter({
      cluster: "mainnet-beta",
      enabled,
      minIntervalMs: 0,
      maxRetries: 0,
      now: () => t,
      sleep: async () => undefined,
      fetch: async (url) => {
        calls.push(url);
        const r = res();
        return {
          status: r.status,
          headers: { get: (n) => (n.toLowerCase() === "retry-after" ? (r.retry ?? null) : null) },
          text: async () => r.text,
        };
      },
    });
    return { a, calls, advance: (ms: number) => (t += ms) };
  }

  it("memakai respons pricing fixture, satu request untuk banyak pembacaan", async () => {
    const { a, calls } = setup(true, () => ({ status: 200, text: body }));
    const o = await a.solUsdObservation();
    await a.solUsdObservation();
    expect(o.usd).toBeCloseTo(95.8424858316876);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`/launchlab/pricing?quoteMint=${WSOL_MINT}`);
  });

  it("terkunci: tidak ada request HTTP sama sekali", async () => {
    const { a, calls } = setup(false, () => ({ status: 200, text: body }));
    await expect(a.solUsdObservation()).rejects.toThrow("locked");
    expect(calls).toEqual([]);
  });

  it("Retry-After melewati jatah tunggu: request berikutnya tidak dikirim sampai lewat", async () => {
    const replies = [
      { status: 429, text: "{}", retry: "600" },
      { status: 200, text: body },
    ];
    const adapter = new MainnetStonkFunAdapter({
      cluster: "mainnet-beta",
      enabled: true,
      minIntervalMs: 0,
      maxRetries: 2,
      cacheMs: 0,
      now: () => t,
      sleep: async () => undefined,
      fetch: async () => {
        count++;
        const r = replies.shift()!;
        return {
          status: r.status,
          headers: { get: () => r.retry ?? null },
          text: async () => r.text,
        };
      },
    });
    let t = NOW;
    let count = 0;
    await expect(adapter.solUsdObservation()).rejects.toThrow();
    await expect(adapter.solUsdObservation()).rejects.toThrow();
    expect(count).toBe(1);
    t += 600_000;
    await expect(adapter.solUsdObservation()).resolves.toMatchObject({ usd: expect.any(Number) });
    expect(count).toBe(2);
  });

  it("createSolPriceOracle: null di luar mainnet; flag mati = unverified tanpa angka", async () => {
    const settings = { config: cfg, jupiterApiUrl: "http://127.0.0.1:1", stonkfunEnabled: false };
    expect(createSolPriceOracle("devnet", settings)).toBeNull();
    const p = await createSolPriceOracle("mainnet-beta", settings)!.read();
    expect(p).toMatchObject({ status: "unverified", usd: null });
    expect(p.issues).toContain("stonkfun_unreadable");
  });
});

describe("usdRatesFor", () => {
  const verified = evaluateSolPrice(obs(95), obs(95), cfg, NOW);
  const unverified = evaluateSolPrice(obs(95), down(), cfg, NOW);

  it("devnet tetap harga asumsi, apa pun status harga mainnet", () => {
    const r = usdRatesFor("devnet", unverified);
    expect(r.kind).toBe("assumed");
    expect(r.rateFor(WSOL_MINT)).toBe(150);
  });

  it("mainnet: tanpa harga quote lain = NaN (bukan 0), dan semua hanya bila SOL terverifikasi", () => {
    const r = usdRatesFor("mainnet-beta", verified);
    expect(r).toMatchObject({ kind: "live", observedAt: verified.observedAt });
    expect(r.rateFor(WSOL_MINT)).toBe(95);
    expect(r.rateFor("USDC")).toBeNaN();
    for (const s of [unverified, null]) {
      const n = usdRatesFor("mainnet-beta", s);
      expect(n.kind).toBe("none");
      expect(n.rateFor(WSOL_MINT)).toBe(0);
    }
  });
});

describe("solPriceSettingsFrom", () => {
  it("default dari config; override env dibatasi", () => {
    expect(solPriceSettingsFrom({} as NodeJS.ProcessEnv).config).toEqual(cfg);
    const env = { SOL_PRICE_MAX_AGE_SECONDS: "60", STONKFUN_MAINNET_ENABLED: "1" };
    const s = solPriceSettingsFrom(env as unknown as NodeJS.ProcessEnv);
    expect(s.config.maxAgeSeconds).toBe(60);
    expect(s.stonkfunEnabled).toBe(true);
    for (const bad of [
      { SOL_PRICE_MAX_DEVIATION_BPS: "10001" },
      { SOL_PRICE_MAX_DEVIATION_BPS: "0" },
      { SOL_PRICE_MAX_AGE_SECONDS: "86400" },
      { SOL_PRICE_REFRESH_MS: "x" },
    ]) {
      expect(() => solPriceSettingsFrom(bad as unknown as NodeJS.ProcessEnv)).toThrow();
    }
  });
});

describe("akses pair non-SOL", () => {
  it("tertutup kecuali PAIRS_NON_SOL_ENABLED tepat 1", () => {
    expect(pairAccessFrom({} as NodeJS.ProcessEnv).nonSolEnabled).toBe(false);
    for (const v of ["0", "true", "ya", ""]) {
      expect(pairAccessFrom({ PAIRS_NON_SOL_ENABLED: v } as NodeJS.ProcessEnv).nonSolEnabled).toBe(
        false,
      );
    }
    expect(pairAccessFrom({ PAIRS_NON_SOL_ENABLED: "1" } as NodeJS.ProcessEnv).nonSolEnabled).toBe(
      true,
    );
  });
});

describe("katalog quote", () => {
  const MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";

  it("simbol & desimal dari katalog; registri tetap menang; tak dikenal = undefined", () => {
    rememberQuoteAssets("mainnet-beta", [
      { mint: MINT, symbol: "SPYX", name: "SP500", decimals: 8, raiseRaw: "1054878163" },
    ]);
    expect(pairForMint("mainnet-beta", MINT)).toMatchObject({ symbol: "SPYX", decimals: 8 });
    expect(pairForToken("mainnet-beta", { quoteMint: MINT, quoteConfigId: "CFG" })).toMatchObject({
      symbol: "SPYX",
      decimals: 8,
      configId: "CFG",
    });
    const sol = pairsFor("mainnet-beta")[0]!;
    expect(
      pairForToken("mainnet-beta", { quoteMint: WSOL_MINT, quoteConfigId: sol.configId }),
    ).toBe(sol);
    expect(pairForMint("mainnet-beta", "TIDAK-ADA")).toBeUndefined();
    expect(pairForMint("devnet", MINT)).toBeUndefined();
  });

  it("batas per quote setara nilai SOL lewat raise, untuk berbagai desimal", () => {
    const sol = ECONOMIC_CONFIG.minBuybackRaw;
    // Raise setara 85 SOL: 0,01 SOL = 1/8500 dari raise.
    const cases = [
      ["QUOTE2", "850000", 100n], // 2 desimal
      ["QUOTE6", "8041995940", 946117n], // 6 desimal (USDC)
      ["QUOTE12", "85000000000000000", 10000000000000n], // 12 desimal
    ] as const;
    for (const [mint, raise, expected] of cases) {
      rememberQuoteAssets("mainnet-beta", [
        { mint, symbol: mint, name: mint, decimals: 6, raiseRaw: raise },
      ]);
      expect(perQuote(sol, mint)).toBe(expected);
    }
    // SOL & entri eksplisit tidak berubah; mint bukan quote tetap `default`.
    expect(perQuote(sol, WSOL_MINT)).toBe(10_000_000n);
    expect(perQuote({ ...sol, QUOTE6: "7" }, "QUOTE6")).toBe(7n);
    expect(perQuote(sol, "TOKEN-LIFTOFF")).toBe(1_000_000n);
    expect(SOL_REFERENCE_RAISE_RAW).toBe("85000000000");
  });

  it("nilai sangat kecil dibulatkan ke 1, tidak pernah 0", () => {
    rememberQuoteAssets("mainnet-beta", [
      { mint: "QUOTE-KECIL", symbol: "K", name: "K", decimals: 2, raiseRaw: "1" },
    ]);
    expect(perQuote(ECONOMIC_CONFIG.minBuybackRaw, "QUOTE-KECIL")).toBe(1n);
  });
});

describe("QuotePriceBook & JupiterPriceBatch", () => {
  const T = 1_800_000_000_000;
  const obs = (usd: number, at = T) => ({ usd, observedAtMs: at });

  it("dua sumber wajib terbaca; selisih lewat batas = n/a; per mint terpisah", async () => {
    const prices: Record<string, [number, number]> = { A: [1, 1.001], B: [100, 110] };
    const book = new QuotePriceBook({
      now: () => T,
      stonkfun: (m) =>
        prices[m] ? Promise.resolve(obs(prices[m]![0])) : Promise.reject(new Error("x")),
      jupiter: (m) =>
        prices[m] ? Promise.resolve(obs(prices[m]![1])) : Promise.reject(new Error("x")),
    });
    expect(await book.read("A")).toMatchObject({ status: "verified", usd: 1 });
    expect(await book.read("B")).toMatchObject({
      status: "unverified",
      usd: null,
      issues: ["deviation_too_large"],
    });
    expect((await book.read("TIDAK-ADA")).status).toBe("unverified");
  });

  it("hanya mint yang diminta yang dibaca; banyak permintaan = satu bacaan; dibatasi jumlah mint", async () => {
    const read: string[] = [];
    const book = new QuotePriceBook({
      now: () => T,
      maxMints: 2,
      stonkfun: (m) => {
        read.push(m);
        return Promise.resolve(obs(1));
      },
      jupiter: () => Promise.resolve(obs(1)),
    });
    await Promise.all([book.read("A"), book.read("A"), book.read("A")]);
    expect(read).toEqual(["A"]);
    await book.read("B");
    await book.read("C"); // A terlama → dilepas
    await book.read("A"); // dibaca ulang
    expect(read).toEqual(["A", "B", "C", "A"]);
  });

  it("Jupiter digabung jadi satu request; mint yang hilang gagal sendiri", async () => {
    const urls: string[] = [];
    const batch = new JupiterPriceBatch({
      delayMs: 0,
      now: () => T,
      fetch: async (url) => {
        urls.push(url);
        return {
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ A: { usdPrice: 2 } }),
        };
      },
    });
    const [a, b] = await Promise.allSettled([batch.read("A"), batch.read("B")]);
    expect(urls).toEqual(["https://lite-api.jup.ag/price/v3?ids=A,B"]);
    expect(a).toMatchObject({ status: "fulfilled", value: { usd: 2 } });
    expect(b.status).toBe("rejected");
  });

  it("usdRatesFor: quote tanpa harga = NaN agar total ikut n/a; SOL tetap", () => {
    const snap = evaluateSolPrice(
      { observation: obs(95), error: null },
      { observation: obs(95), error: null },
      SOL_PRICE_CONFIG,
      T,
    );
    const quotes = {
      current: (m: string) =>
        m === "A"
          ? snap
          : evaluateSolPrice(
              { observation: null, error: "x" },
              { observation: null, error: "x" },
              SOL_PRICE_CONFIG,
              T,
            ),
    };
    const r = usdRatesFor("mainnet-beta", snap, quotes);
    expect(r.rateFor(WSOL_MINT)).toBe(95);
    expect(r.rateFor("A")).toBe(95);
    expect(r.rateFor("B")).toBeNaN();
    expect(usdRatesFor("mainnet-beta", snap).rateFor("A")).toBeNaN();
  });

  it("parseStonkFunQuotePrice: quoteUsd wajib, positif, waktu valid", () => {
    const at = "2026-11-02T09:06:34.985Z";
    expect(parseStonkFunQuotePrice({ quoteUsd: 0.99, observedAt: at }).usd).toBe(0.99);
    for (const bad of [
      { observedAt: at },
      { quoteUsd: 0, observedAt: at },
      { quoteUsd: "1", observedAt: at },
      { quoteUsd: 1, observedAt: "bukan" },
      null,
    ]) {
      expect(() => parseStonkFunQuotePrice(bad)).toThrow();
    }
  });
});

describe("evaluateReserveDeployment tanpa harga", () => {
  const input = {
    nowSeconds: 1_000_000,
    poolActive: true,
    graduated: true,
    poolCompatible: true,
    swapRouteAvailable: true,
    reserveBalanceUsd: 1_000,
    poolLiquidityUsd: 1_000,
    priceAgeSeconds: 10,
    oneHourMoveBps: 0,
    simulatedPriceImpactBps: 0,
    lastDeployAtSeconds: null,
    graduatedAtSeconds: 1,
    paused: false,
  };

  it("nilai USD tidak diketahui → gagal tertutup, dengan alasan yang benar", () => {
    expect(evaluateReserveDeployment(input).allowed).toBe(true);
    const d = evaluateReserveDeployment({
      ...input,
      reserveBalanceUsd: null,
      poolLiquidityUsd: null,
      priceAgeSeconds: null,
    });
    expect(d.allowed).toBe(false);
    expect(d.maxDeployUsd).toBe(0);
    expect(d.failedSafetyChecks).toEqual(["reserve_sufficient", "price_data_reliable"]);
    expect(d.reasons.join(" ")).toContain("unknown without a verified price");
    expect(d.reasons.join(" ")).not.toContain("below");
  });

  it("umur harga lewat batas reserve (lebih ketat dari batas tampilan) → ditahan", () => {
    const old = RESERVE_CONFIG.maxPriceAgeSeconds + 1;
    expect(RESERVE_CONFIG.maxPriceAgeSeconds).toBeLessThan(SOL_PRICE_CONFIG.maxAgeSeconds);
    expect(
      evaluateReserveDeployment({ ...input, priceAgeSeconds: old }).failedSafetyChecks,
    ).toEqual(["price_data_reliable"]);
  });
});
