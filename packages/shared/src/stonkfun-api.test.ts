import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { CUSTOM_PAIR_WARNING, NON_SOL_CLOSED_MESSAGE } from "./pairs";
import { launchInputSchema } from "./schemas";
import {
  adoptionRequirementViolations,
  emulatedPricing,
  launchFingerprint,
  requireLaunchablePair,
  StaticStonkFunAdapter,
  StonkFunUnavailableError,
} from "./stonkfun";
import {
  MainnetStonkFunAdapter,
  pricingResponseSchema,
  StonkFunHttp,
  type FetchLike,
} from "./stonkfun-api";
import { z } from "zod";

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/stonkfun/${name}.json`, import.meta.url), "utf8");
const MASTER = "4xU25ckRqi5aeRZsAvZotvBCRcyQH3rvdPN3x5pgmCFj";
const SOL = "So11111111111111111111111111111111111111112";
const MINT = "7XQ1HsYxFEbcUnKC6TeWgsVEqLpuKzEvdccV585hqJue";
/** Respons ASLI `/launchlab/pricing?quoteMint=SOL` (pemilik, 2026-10-31). */
const PRICING = "pricing-sol-mainnet-2026-10-31";
/** Alamat dari respons asli; PDA-nya dibuktikan di packages/solana (launchlab.test.ts). */
const REAL = {
  program: "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj",
  config: "6s1xP3hpbAfFoNtUNF8mfHsjr2Bd97JxFJRWLbL6aHuX",
  platform: "4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7",
  allowConfig: "GvAsQKFETH8YwRWxAYLFUy6L83frgHRsnw1FwC1asmJJ",
  curveRule: "9emka7JGUqvjzXvd95KQTPBEdBU6Ds43f238jXhBvUmN",
};

type Reply = { status: number; body: string; headers?: Record<string, string> } | "hang";

/** fetch palsu: antrean balasan per path (tanpa query); mencatat URL yang diminta. */
function fakeFetch(routes: Record<string, Reply[]>) {
  const calls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(url);
    const path = new URL(url).pathname.replace("/api/public/v1", "");
    const queue = routes[path];
    const reply = queue && (queue.length > 1 ? queue.shift()! : queue[0]!);
    if (!reply) return { status: 404, headers: { get: () => null }, text: async () => "{}" };
    if (reply === "hang") {
      return new Promise((_, reject) =>
        init.signal.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    }
    return {
      status: reply.status,
      headers: { get: (n: string) => reply.headers?.[n.toLowerCase()] ?? null },
      text: async () => reply.body,
    };
  };
  return { fetch, calls };
}

const ok = (name: string): Reply => ({ status: 200, body: fixture(name) });

const SPL_MINT = {
  program: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  decimals: 9,
  issue: null as string | null,
  warnings: [] as string[],
};
/** Hasil baca mint on-chain per test; mint lain = SPL 9 desimal tanpa masalah. */
let mintInfo: Record<string, typeof SPL_MINT | null> = {};

function adapter(
  routes: Record<string, Reply[]>,
  extra: Partial<{ enabled: boolean }> = {},
  derived: { allowConfigId: string; curveRuleId: string } = {
    allowConfigId: REAL.allowConfig,
    curveRuleId: REAL.curveRule,
  },
) {
  const f = fakeFetch(routes);
  const sleeps: number[] = [];
  let t = 1_000_000;
  const a = new MainnetStonkFunAdapter({
    cluster: "mainnet-beta",
    enabled: true,
    fetch: f.fetch,
    minIntervalMs: 0,
    timeoutMs: 50,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    onchain: {
      launchlabProgram: "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj",
      masterWallet: MASTER,
      creatorVault: () => "VAULT",
      launchAccounts: () => derived,
      quoteMint: async (mint) => (mint in mintInfo ? mintInfo[mint]! : SPL_MINT),
      platformConfig: async () => ({
        platformFeeRate: 10_000,
        creatorFeeRate: 5_000,
        cpConfigId: "CP",
        cpmmCreatorFeeRate: 2_500,
        restrictsGlobalConfig: false,
      }),
    },
    ...extra,
  });
  return { a, calls: f.calls, sleeps, advance: (ms: number) => (t += ms) };
}

const ROUTES = () => ({
  "/pairs": [ok("pairs")],
  "/launchlab/pricing": [ok(PRICING)],
});

describe("MainnetStonkFunAdapter — terkunci", () => {
  it.each([
    ["devnet + flag", { cluster: "devnet" as const, enabled: true }],
    ["mainnet tanpa flag", { cluster: "mainnet-beta" as const, enabled: false }],
  ])("%s → semua method menolak not_active tanpa request HTTP", async (_n, o) => {
    const f = fakeFetch(ROUTES());
    const a = new MainnetStonkFunAdapter({ ...o, fetch: f.fetch });
    expect(a.active).toBe(false);
    for (const call of [
      () => a.listPairs(),
      () => a.activeLaunchConfig(),
      () => a.creatorFees(MINT),
      () => a.adoptionStatus(MINT, SOL),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "not_active" });
    }
    expect(f.calls).toHaveLength(0);
  });
});

describe("MainnetStonkFunAdapter — fixture OpenAPI", () => {
  it("ID pair dari listPairs diterima input launch", async () => {
    const { a } = adapter(ROUTES());
    const { pairs } = await a.listPairs();
    expect(pairs.length).toBeGreaterThan(0);
    for (const { id } of pairs) {
      const parsed = launchInputSchema.safeParse({
        name: "Valid Name",
        ticker: "VALID",
        pairId: id,
      });
      expect(parsed.error?.issues ?? []).toEqual([]);
    }
    // Mint Solana terpanjang (44 karakter) tetap muat.
    const longest = `sf-${"1".repeat(44)}`;
    expect(
      launchInputSchema.safeParse({ name: "Valid Name", ticker: "VALID", pairId: longest }).success,
    ).toBe(true);
  });

  it("listPairs: satu request tanpa pricing; pair lain tidak siap dengan alasan", async () => {
    const { a, calls } = adapter(ROUTES());
    expect(a.feeIntake).toBe("forwarded");
    const list = await a.listPairs();
    const sol = list.pairs.find((p) => p.symbol === "SOL")!;
    expect(sol).toMatchObject({
      launchable: true,
      launchLabReady: true,
      configId: "",
      graduationRaw: null,
      decimals: 9,
    });
    const spyx = list.pairs.find((p) => p.symbol === "SPYx")!;
    expect(spyx).toMatchObject({
      launchLabReady: false,
      quoteTokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
      tokenized: true,
    });
    expect(spyx.unavailableReason).toMatch(/LaunchLab/);
    expect(list.pairs.find((p) => p.symbol === "OLD")!.unavailableReason).toMatch(/retired/);
    expect(calls[0]).toMatch(/\/api\/public\/v1\/pairs$/);
    expect(calls.filter((c) => c.includes("/pricing"))).toHaveLength(0);
    await a.listPairs();
    expect(calls).toHaveLength(1);
  });

  describe("semua pair StonkFun", () => {
    const row = (mint: string, over: Record<string, unknown> = {}) => ({
      mint,
      symbol: "AAA",
      name: "Token A",
      decimals: 6,
      category: "backpack",
      categoryLabel: "Backpack",
      tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      logoUrl: `/api/asset/quote-logo/${mint}?v=1`,
      launchable: true,
      launchLabReady: true,
      symbolAmbiguous: false,
      ...over,
    });
    const M1 = "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump";
    const M2 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const M3 = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
    const rows = [
      row(M1, {
        symbol: "ANSEM",
        category: "custom",
        categoryLabel: "Custom",
        symbolAmbiguous: true,
      }),
      row(M2, { symbol: "USDC" }),
      row(M3, { symbol: "PENGUIN", launchLabReady: false }),
      row(SOL, { symbol: "SOL", decimals: 9, category: "solana", categoryLabel: "Solana" }),
    ];
    const pricing = (mint: string) => {
      const d = JSON.parse(fixture(PRICING));
      d.data.quote.mint = mint;
      d.data.curve.configId = "8gj14w8vkNZjJTPak6e96Uf1sY438WKheH4s5dHyxiRw";
      d.data.raise.raw = "8041995940";
      return { status: 200, body: JSON.stringify(d) } as Reply;
    };
    const make = (nonSolEnabled: boolean, routes?: Record<string, Reply[]>) => {
      const made = adapter(
        routes ?? {
          "/pairs": [{ status: 200, body: JSON.stringify({ data: { pairs: rows } }) }],
          "/launchlab/pricing": [pricing(M2)],
        },
        { access: { nonSolEnabled } } as never,
      );
      return made;
    };
    beforeEach(() => {
      mintInfo = {};
    });

    it("615 pair: listPairs tetap satu request, SOL lebih dulu, tanpa pricing", async () => {
      const many = Array.from({ length: 615 }, (_, i) =>
        row(`${"1".repeat(30)}${String(i).padStart(4, "0")}`, { symbol: `P${i}` }),
      );
      const { a, calls } = make(true, {
        "/pairs": [
          {
            status: 200,
            body: JSON.stringify({ data: { pairs: [...many, row(SOL, { symbol: "SOL" })] } }),
          },
        ],
      });
      const list = await a.listPairs();
      expect(list.pairs).toHaveLength(616);
      expect(list.pairs[0]!.mint).toBe(SOL);
      expect(calls).toHaveLength(1);
    });

    it("tombol tertutup: non-SOL tampil tidak tersedia dengan alasan, SOL tetap siap, tanpa pricing", async () => {
      const { a, calls } = make(false);
      const list = await a.listPairs();
      expect(list.pairs.find((p) => p.mint === SOL)!.launchLabReady).toBe(true);
      const usdc = list.pairs.find((p) => p.mint === M2)!;
      expect(usdc.supported).toBe(false);
      expect(usdc.unavailableReason).toBe(NON_SOL_CLOSED_MESSAGE);
      expect(await a.resolvePair(usdc)).toBe(usdc);
      expect(calls.filter((c) => c.includes("/pricing"))).toHaveLength(0);
      expect(() => requireLaunchablePair(list, { id: usdc.id })).toThrow(NON_SOL_CLOSED_MESSAGE);
    });

    it("tombol terbuka: yang belum ready tetap tidak tersedia dengan alasannya", async () => {
      const { a } = make(true);
      const list = await a.listPairs();
      expect(list.pairs.find((p) => p.mint === M2)!.supported).toBe(true);
      expect(list.pairs.find((p) => p.mint === M3)).toMatchObject({
        supported: false,
        unavailableReason: expect.stringMatching(/no LaunchLab config/),
      });
    });

    it("custom berlabel peringatan; simbol ambigu ditandai; logo absolut; ID memuat mint penuh", async () => {
      const { a } = make(true);
      const ansem = (await a.listPairs()).pairs.find((p) => p.mint === M1)!;
      expect(ansem).toMatchObject({
        id: `sf-${M1}`,
        symbolAmbiguous: true,
        category: "custom",
        categoryLabel: "Custom",
        warnings: [CUSTOM_PAIR_WARNING],
        logoUrl: `https://www.stonkfun.xyz/api/asset/quote-logo/${M1}?v=1`,
      });
    });

    it("logo selain path relatif diabaikan", async () => {
      const { a } = make(true, {
        "/pairs": [
          {
            status: 200,
            body: JSON.stringify({
              data: {
                pairs: [
                  row(M1, { logoUrl: "https://jahat.test/x.png" }),
                  row(M2, { logoUrl: "//jahat.test/x.png" }),
                ],
              },
            }),
          },
        ],
      });
      for (const p of (await a.listPairs()).pairs) expect(p.logoUrl).toBeNull();
    });

    it("resolvePair: config & raise dari pricing, satu request per mint, dengan cache", async () => {
      mintInfo[M2] = { ...SPL_MINT, decimals: 6, warnings: ["awas"] };
      const { a, calls } = make(true);
      const usdc = (await a.listPairs()).pairs.find((p) => p.mint === M2)!;
      const r = await a.resolvePair(usdc);
      expect(r).toMatchObject({
        configId: "8gj14w8vkNZjJTPak6e96Uf1sY438WKheH4s5dHyxiRw",
        graduationRaw: "8041995940",
        minFundRaisingRaw: "24000000000",
        supported: true,
        warnings: ["awas"],
      });
      await a.resolvePair(usdc);
      expect(calls.filter((c) => c.includes("/pricing"))).toHaveLength(1);
    });

    it.each([
      ["transfer fee", { ...SPL_MINT, decimals: 6, issue: "fee" }, /fee/],
      ["mint tidak ada", null, /not found/],
      ["desimal beda dengan chain", { ...SPL_MINT, decimals: 9 }, /different decimals/],
    ])("resolvePair menolak: %s", async (_n, info, reason) => {
      mintInfo[M2] = info;
      const { a } = make(true);
      const usdc = (await a.listPairs()).pairs.find((p) => p.mint === M2)!;
      expect(await a.resolvePair(usdc)).toMatchObject({
        supported: false,
        launchLabReady: false,
        unavailableReason: expect.stringMatching(reason),
      });
    });

    it("harga quote dari respons pricing yang sama; rusak melempar", async () => {
      const { a } = make(true);
      const usd = await a.quoteUsdObservation(M2);
      expect(usd.usd).toBeGreaterThan(0);
      const { a: b } = make(true, {
        "/launchlab/pricing": [
          {
            status: 200,
            body: (() => {
              const d = JSON.parse(fixture(PRICING));
              d.data.quote.mint = M2;
              delete d.data.prices.quoteUsd;
              return JSON.stringify(d);
            })(),
          },
        ],
      });
      await expect(b.quoteUsdObservation(M2)).rejects.toThrow();
    });

    it("sidik jari non-SOL tidak berubah saat raise ikut harga; SOL tetap dijaga", () => {
      const cfg = {
        source: "stonkfun_mainnet",
        launchlabProgram: "L",
        platformId: "P",
        platformFeeRate: 1,
        creatorFeeRate: 1,
        cpConfigId: "C",
        cpmmCreatorFeeRate: 1,
        restrictsGlobalConfig: false,
        fetchedAt: "",
      } as const;
      const pricingOf = (raise: string) =>
        ({
          supply: "1",
          totalSellA: "1",
          baseTokenProgram: "token2022",
          baseDecimals: 6,
          totalFundRaisingB: raise,
          curveRuleId: null,
          cpmmCreatorFeeOn: 0,
          allowConfigId: null,
        }) as never;
      const base = { configId: "X", decimals: 6, curveType: 0, minFundRaisingRaw: "0" };
      const usdc = { ...base, mint: M2 } as never;
      const sol = { ...base, mint: SOL } as never;
      expect(launchFingerprint(cfg, usdc, pricingOf("1"))).toBe(
        launchFingerprint(cfg, usdc, pricingOf("2")),
      );
      expect(launchFingerprint(cfg, sol, pricingOf("1"))).not.toBe(
        launchFingerprint(cfg, sol, pricingOf("2")),
      );
    });
  });

  it("respons pricing ASLI lolos skema: raise.raw string → totalFundRaisingB, quote.mint, allowConfig", () => {
    const d = pricingResponseSchema.parse(JSON.parse(fixture(PRICING))).data;
    expect(d.raise).toMatchObject({
      totalFundRaisingB: "85000000000",
      units: 85,
      minimumRaw: "24000000000",
    });
    expect(d.quote?.mint).toBe(SOL);
    expect(d.curve).toMatchObject({
      curveType: "ConstantCurve",
      derived: { virtualA: "1073025605596382", virtualB: "30000852951" },
    });
    expect(d.allowConfig?.required?.standard).toBe(true);
    expect(d.allowConfig?.available?.community).toBe(false);
    expect(d.marketCap?.graduationUsd).toBeCloseTo(39374.63, 2);
    expect(d.standardV2Enabled).toBe(false);
    expect(d.modes?.standard?.transferFee).toBeNull();
    // Bentuk lama dari dokumen (raise.raw.totalFundRaisingB, quoteMint) tetap diterima.
    const legacy = {
      ...JSON.parse(fixture(PRICING)).data,
      quote: undefined,
      quoteMint: SOL,
      raise: { raw: { totalFundRaisingB: "1" } },
    };
    expect(pricingResponseSchema.parse({ data: legacy }).data.raise.totalFundRaisingB).toBe("1");
  });

  it("launchPricing (respons asli): configId, platform standard, allow-config + curve-rule, raise 85 SOL, Token-2022 6 desimal", async () => {
    const { a } = adapter(ROUTES());
    const pair = await a.resolvePair((await a.listPairs()).pairs.find((p) => p.symbol === "SOL")!);
    const pricing = await a.launchPricing(pair);
    expect(pricing).toMatchObject({
      configId: REAL.config,
      launchlabProgram: REAL.program,
      platformId: REAL.platform,
      allowConfigId: REAL.allowConfig,
      allowConfigRequired: true,
      allowConfigAvailable: true,
      curveRuleId: REAL.curveRule,
      curveType: "ConstantCurve",
      standardTransferFee: false,
      totalFundRaisingB: "85000000000",
      supply: "1000000000000000",
      totalSellA: "793100000000000",
      baseDecimals: 6,
      baseTokenProgram: "token2022",
      migrateType: "cpmm",
      observedAt: "2026-10-31T12:35:43.178Z",
    });
    expect(pricing.marketCapUsd?.graduation).toBeCloseTo(39374.63, 2);
    expect(adoptionRequirementViolations(pricing, pair, { requireCurveRule: true })).toEqual([]);
    const cfg = await a.activeLaunchConfig();
    expect(cfg).toMatchObject({ platformId: pricing.platformId, creatorFeeRate: 5_000 });
    // Sidik jari ikut berubah bila raise atau allow-config berubah.
    const fp = launchFingerprint(cfg, pair, pricing);
    expect(fp).toContain(`allow:${REAL.allowConfig}`);
    expect(fp).not.toBe(launchFingerprint(cfg, pair, { ...pricing, totalFundRaisingB: "1" }));
    expect(fp).not.toBe(launchFingerprint(cfg, pair, { ...pricing, allowConfigId: "X" }));
  });

  it("allow-config / curve-rule API ≠ PDA turunan lokal → config_changed", async () => {
    const pairOf = async (a: MainnetStonkFunAdapter) =>
      (await a.listPairs()).pairs.find((p) => p.symbol === "SOL")!;
    const wrongAllow = adapter(
      ROUTES(),
      {},
      { allowConfigId: MASTER, curveRuleId: REAL.curveRule },
    );
    await expect(wrongAllow.a.launchPricing(await pairOf(wrongAllow.a))).rejects.toMatchObject({
      code: "config_changed",
      message: expect.stringMatching(/allow-config/),
    });
    const wrongRule = adapter(
      ROUTES(),
      {},
      { allowConfigId: REAL.allowConfig, curveRuleId: MASTER },
    );
    await expect(wrongRule.a.launchPricing(await pairOf(wrongRule.a))).rejects.toMatchObject({
      code: "config_changed",
      message: expect.stringMatching(/curve-rule/),
    });
  });

  it("available.standard false / null, required tanpa alamat, transfer fee, kurva lain → launch ditolak", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tambalan JSON bebas bentuk di test
    const variant = (patch: (d: Record<string, any>) => void): Reply => {
      const body = JSON.parse(fixture(PRICING));
      patch(body.data);
      return { status: 200, body: JSON.stringify(body) };
    };
    const violationsFor = async (reply: Reply) => {
      const { a } = adapter({ "/pairs": [ok("pairs")], "/launchlab/pricing": [reply] });
      const pair = await a.resolvePair(
        (await a.listPairs()).pairs.find((p) => p.symbol === "SOL")!,
      );
      return adoptionRequirementViolations(await a.launchPricing(pair), pair, {
        requireCurveRule: true,
      });
    };
    expect(await violationsFor(variant((d) => (d.allowConfig.available.standard = false)))).toEqual(
      ["the StonkFun platform does not allow this quote right now (allow-config)"],
    );
    expect(await violationsFor(variant((d) => (d.allowConfig.available.standard = null)))).toEqual([
      "the StonkFun platform allow-list could not be read",
    ]);
    expect(await violationsFor(variant((d) => (d.allowConfig = null)))).toEqual([
      "the StonkFun platform allow-list could not be read",
    ]);
    expect(await violationsFor(variant((d) => (d.allowConfig.standard = null)))).toEqual([
      "allow-config account is missing",
    ]);
    expect(
      await violationsFor(variant((d) => (d.modes.standard.transferFee = { bps: 100 }))),
    ).toEqual(["standard mode asks for a transfer fee extension"]);
    expect(await violationsFor(variant((d) => (d.curve.curveType = "LinearCurve")))).toEqual([
      "curve type LinearCurve is not supported",
    ]);
    // Pricing untuk quote lain → ditolak sebelum dipakai.
    const { a } = adapter({
      "/pairs": [ok("pairs")],
      "/launchlab/pricing": [variant((d) => (d.quote.mint = MINT))],
    });
    const pairs = await a.listPairs();
    expect(pairs.pairs.find((p) => p.symbol === "SOL")!.launchLabReady).toBe(true);
    await expect(
      a.launchPricing(pairs.pairs.find((p) => p.symbol === "SOL")!),
    ).rejects.toMatchObject({ code: "config_changed" });
  });

  it("adopsi: launchpad launchlab → adopted; 404 dalam jendela → pending; lewat jendela → not_found; cek silang /launches", async () => {
    const adopted = adapter({ [`/tokens/${MINT}`]: [ok("token-adopted")] });
    expect((await adopted.a.adoptionStatus(MINT, SOL)).state).toBe("adopted");

    const notFound: Reply = { status: 404, body: '{"error":{"code":"not_found","message":"x"}}' };
    const pending = adapter({
      [`/tokens/${MINT}`]: [notFound],
      "/launches": [{ status: 200, body: '{"data":[]}' }],
    });
    const now = new Date(1_000_000);
    expect((await pending.a.adoptionStatus(MINT, SOL, now)).state).toBe("pending");
    expect(pending.calls.some((c) => c.includes(`creator=${MASTER}`))).toBe(true);
    pending.advance(11 * 60_000);
    expect((await pending.a.adoptionStatus(MINT, SOL, now)).state).toBe("not_found");

    const viaLaunches = adapter({ [`/tokens/${MINT}`]: [notFound], "/launches": [ok("launches")] });
    expect((await viaLaunches.a.adoptionStatus(MINT, SOL)).state).toBe("adopted");
  });

  it("adopsi: respons tanpa data.token ditolak, bukan dianggap belum diadopsi", async () => {
    const flat = adapter({
      [`/tokens/${MINT}`]: [{ status: 200, body: `{"data":{"mint":"${MINT}"}}` }],
    });
    await expect(flat.a.adoptionStatus(MINT, SOL)).rejects.toThrow(/tidak sesuai skema/);
  });

  it("creatorFees: diteruskan (claimable null) vs launch lama scope creator-quote-vault", async () => {
    const fwd = adapter({ [`/tokens/${MINT}/fees`]: [ok("fees-forwarded")] });
    expect(await fwd.a.creatorFees(MINT)).toMatchObject({ claimable: null, scope: null });
    const old = adapter({ [`/tokens/${MINT}/fees`]: [ok("fees-quote-vault")] });
    expect(await old.a.creatorFees(MINT)).toMatchObject({
      claimable: { base: "0", quote: "123456789" },
      scope: "creator-quote-vault",
    });
  });
});

describe("StonkFunHttp — rate limit, Retry-After, timeout, error code", () => {
  const schema = z.object({ data: z.object({ v: z.number() }) });
  const http = (routes: Record<string, Reply[]>, maxRetries = 2) => {
    const f = fakeFetch(routes);
    const sleeps: number[] = [];
    const h = new StonkFunHttp({
      fetch: f.fetch,
      minIntervalMs: 0,
      timeoutMs: 20,
      maxRetries,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    return { h, sleeps, calls: f.calls };
  };

  it("429 → menunggu retryAfterSeconds dari body, lalu berhasil", async () => {
    const { h, sleeps } = http({
      "/x": [
        { status: 429, body: fixture("error-rate-limited") },
        { status: 200, body: '{"data":{"v":1}}' },
      ],
    });
    await expect(h.get("/x", {}, schema)).resolves.toEqual({ data: { v: 1 } });
    expect(sleeps).toContain(2_000);
  });

  it("503 dengan header Retry-After → menunggu header", async () => {
    const { h, sleeps } = http({
      "/x": [
        { status: 503, body: "", headers: { "retry-after": "3" } },
        { status: 200, body: '{"data":{"v":2}}' },
      ],
    });
    await h.get("/x", {}, schema);
    expect(sleeps).toContain(3_000);
  });

  it("error tidak bisa diulang → kode API diteruskan; adapter memetakan ke StonkFunUnavailableError", async () => {
    const { h } = http({
      "/x": [
        { status: 400, body: '{"error":{"code":"invalid_request","message":"bad quoteMint"}}' },
      ],
    });
    await expect(h.get("/x", {}, schema)).rejects.toMatchObject({
      code: "invalid_request",
      status: 400,
      retryable: false,
    });
    const { a } = adapter({
      "/pairs": [
        { status: 500, body: '{"error":{"code":"internal","message":"boom","retryable":true}}' },
      ],
    });
    const err = await a.listPairs().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StonkFunUnavailableError);
    expect(err).toMatchObject({ code: "rpc_unavailable" });
  });

  it("timeout → dicoba ulang lalu gagal sementara", async () => {
    const { h, calls } = http({ "/x": ["hang"] }, 1);
    await expect(h.get("/x", {}, schema)).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
    });
    expect(calls).toHaveLength(2);
  });

  it("respons tidak sesuai skema → invalid_response (tidak dipakai)", async () => {
    const { h } = http({ "/x": [{ status: 200, body: '{"data":{"v":"bukan angka"}}' }] });
    await expect(h.get("/x", {}, schema)).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("syarat adopsi StonkFun", () => {
  it("emulasi devnet memenuhi syarat (tanpa curve-rule); SPL / desimal salah / raise 0 ditolak", async () => {
    const s = new StaticStonkFunAdapter();
    const pair = (await s.listPairs()).pairs[0]!;
    const pricing = await s.launchPricing(pair);
    expect(adoptionRequirementViolations(pricing, pair, { requireCurveRule: false })).toEqual([]);
    expect(adoptionRequirementViolations(pricing, pair, { requireCurveRule: true })).toContain(
      "curve-rule account is missing",
    );
    const bad = emulatedPricing(await s.activeLaunchConfig(), pair, { curveRuleId: null }, "spl");
    expect(
      adoptionRequirementViolations(
        { ...bad, baseDecimals: 9, totalFundRaisingB: "0", migrateType: "amm" },
        pair,
        { requireCurveRule: false },
      ),
    ).toEqual([
      "migration must be CPMM",
      "raise (totalFundRaisingB) must be positive",
      "base mint must have 6 decimals",
      "base mint must be Token-2022",
    ]);
  });
});
