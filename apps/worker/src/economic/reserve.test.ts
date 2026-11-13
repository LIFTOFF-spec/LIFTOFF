import { randomBytes } from "node:crypto";
import {
  createPrismaClient,
  recordTradeAndCreatorFee,
  reserveBalances,
  reserveCustody,
  saveQuoteAsset,
  type Db,
} from "@liftoff/db";
import { prepareTestDatabase, RESETTABLE_TABLES } from "@liftoff/db/testing";
import {
  base58Encode,
  ECONOMIC_CONFIG,
  pairsFor,
  platformFor,
  RESERVE_CONFIG,
  type SolPriceSnapshot,
  type ReserveConfig,
} from "@liftoff/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EconomicEngine } from "./engine";
import { FakeEconomicChain, FakeEconomicSigner, FakeSender } from "./fakes";
import type { EconomicWorkerSettings } from "./ports";
import { ReserveWorker } from "./reserve";
import { runWorkerCycle } from "./runner";

const SOL = pairsFor("devnet").find((p) => p.id === "sol")!;
const PLATFORM = platformFor("devnet");
const MASTER = PLATFORM.masterWallet;
const silent = { info: () => {}, warn: () => {} };
const key = () => base58Encode(randomBytes(32));
const sig = () => base58Encode(randomBytes(64));
const DAY = 86_400_000;
let db: Db;

beforeAll(async () => {
  db = createPrismaClient(await prepareTestDatabase("liftoff_test_worker"));
});
beforeEach(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE ${RESETTABLE_TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
  await db.$executeRawUnsafe(
    `UPDATE "economic_ops" SET "status" = 'failed', "lastError" = 'test reset' WHERE "status" IN ('pending', 'signed', 'submitted')`,
  );
});
afterAll(async () => {
  await db.$disconnect();
});

const SETTINGS: EconomicWorkerSettings = {
  ...ECONOMIC_CONFIG,
  minClaimRaw: { default: "1" },
  minBuybackRaw: { default: "1000000000000" }, // buyback tidak ikut campur di test reserve
  reconcileGraceMs: 60_000,
  retryBackoffMs: 60_000,
  graduatedRoute: "cpmm",
  feeIntake: "claim",
  forwarders: [],
  feeSpendingEnabled: true,
  confirmWaitMs: 0,
  confirmPollMs: 0,
};
/** Threshold $250 diturunkan HANYA di test (seperti .env uji lokal); parameter lain nilai Spec. */
const TEST_RESERVE: ReserveConfig = { ...RESERVE_CONFIG, minBalanceToDeployUsd: 0 };

class Clock {
  t = Date.now();
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
}

function setup(
  config: ReserveConfig = TEST_RESERVE,
  economic: Partial<EconomicWorkerSettings> = {},
) {
  const chain = new FakeEconomicChain(MASTER);
  const nonce = key().slice(0, 6);
  const orig = chain.curveClaimable.bind(chain);
  chain.curveClaimable = async (q: string) => ({ ...(await orig(q)), vault: `vault-${nonce}` });
  const signer = new FakeEconomicSigner();
  const sender = new FakeSender(chain);
  const clock = new Clock();
  const engine = () =>
    new EconomicEngine({
      db,
      chain,
      signer,
      sender,
      cluster: "devnet",
      platform: PLATFORM,
      config: { ...SETTINGS, ...economic },
      logger: silent,
      now: clock.now,
      sleep: async () => {},
    });
  const worker = (e = engine()) =>
    new ReserveWorker({
      db,
      engine: e,
      chain,
      cluster: "devnet",
      platform: PLATFORM,
      settings: { config, intervalMs: 1, minFundRaw: { default: "1" } },
      logger: silent,
      now: clock.now,
    });
  return { chain, signer, sender, clock, engine, worker };
}

let slot = 1_000;
async function seedToken(
  s: ReturnType<typeof setup>,
  ticker: string,
  fee: bigint,
  graduated = true,
  quote: { mint: string; configId: string } = SOL,
) {
  const mint = key();
  const user = await db.user.create({ data: { wallet: key() } });
  await db.token.create({
    data: {
      name: ticker,
      ticker,
      tickerNormalized: ticker.toLowerCase(),
      mint,
      quoteMint: quote.mint,
      quoteConfigId: quote.configId,
      creatorUserId: user.id,
      launchStatus: "live",
      graduatedAt: graduated ? new Date(s.clock.t - 2 * DAY) : null,
    },
  });
  await recordTradeAndCreatorFee(
    db,
    {
      signature: sig(),
      route: "launchlab",
      side: "buy",
      mint,
      wallet: key(),
      amountIn: (fee * 200n).toString(),
      amountOut: "1000000",
      fees: [
        {
          kind: "creator",
          label: "Creator fee",
          rate: 5_000,
          amount: fee.toString(),
          mint: SOL.mint,
          recipient: MASTER,
        },
      ],
      slot: slot++,
    },
    SOL.mint,
    { recordedBy: "indexer" },
  );
  if (graduated) {
    const pool = key();
    const lpMint = key();
    await db.tokenGraduation.create({
      data: {
        tokenMint: mint,
        state: "verified",
        launchPool: key(),
        cpmmPool: pool,
        lpMint,
        addLiquiditySupported: true,
        reserveMonitoringActive: true,
        checkedAt: new Date(),
      },
    });
    s.chain.reservePools.set(mint, {
      pool,
      lpMint,
      lpSupply: 1_000_000_000n,
      reserveToken: 1_000_000_000_000n,
      reserveQuote: 1_000_000_000n, // 1 SOL ≈ $150 < $50k → likuiditas perlu diperkuat
      tokenDecimals: 6,
      quoteDecimals: 9,
      spotPrice: 0.001,
      status: 0,
      depositEnabled: true,
      swapEnabled: true,
      depth2PctQuote: 9_950_000n,
    });
  }
  return mint;
}

/** Claim semua creator fee (vault curve) supaya reserve 20% menjadi dana diterima. */
async function claimAll(s: ReturnType<typeof setup>, total: bigint) {
  s.chain.curveVaults.set(SOL.mint, total);
  s.chain.slot = 900_000 + slot;
  const res = await s.engine().runFeeProcessing();
  expect(res.blocked).toBeNull();
}

const position = async (mint: string) => (await reserveCustody(db, { tokenMint: mint }))[0]!;
const deploys = (mint: string) =>
  db.economicOp.findMany({ where: { kind: "reserve_deploy", tokenMint: mint } });

describe("Conviction Reserve di mainnet: harga SOL/USD", () => {
  const snapshot = (over: Partial<SolPriceSnapshot>): SolPriceSnapshot => ({
    status: "verified",
    usd: 95,
    observedAt: new Date().toISOString(),
    ageSeconds: 30,
    deviationBps: 5,
    issues: [],
    sources: {
      stonkfun: { usd: 95, observedAt: null, ageSeconds: 30, error: null },
      jupiter: { usd: 95, observedAt: null, ageSeconds: 1, error: null },
    },
    checkedAt: new Date().toISOString(),
    ...over,
  });
  const UNVERIFIED = {
    status: "unverified",
    usd: null,
    observedAt: null,
    ageSeconds: null,
  } as const;

  function mainnetWorker(
    s: ReturnType<typeof setup>,
    solPrice: { read(): Promise<SolPriceSnapshot> } | null,
    config: ReserveConfig = TEST_RESERVE,
  ) {
    return new ReserveWorker({
      db,
      engine: s.engine(),
      chain: s.chain,
      cluster: "mainnet-beta",
      platform: PLATFORM,
      settings: { config, intervalMs: 1, minFundRaw: { default: "1" } },
      solPrice,
      logger: silent,
      now: s.clock.now,
    });
  }
  const lastDecision = (mint: string) =>
    db.reserveDecision.findFirstOrThrow({
      where: { tokenMint: mint },
      orderBy: { createdAt: "desc" },
    });

  it.each([
    [
      "selisih lewat batas",
      async () => snapshot({ ...UNVERIFIED, deviationBps: 900, issues: ["deviation_too_large"] }),
      "deviation_too_large",
    ],
    [
      "Jupiter gagal (aturan satu sumber)",
      async () => snapshot({ ...UNVERIFIED, issues: ["jupiter_unreadable"] }),
      "jupiter_unreadable",
    ],
    [
      "data tua",
      async () => snapshot({ ...UNVERIFIED, issues: ["stonkfun_stale"] }),
      "stonkfun_stale",
    ],
    [
      "pembaca melempar",
      async () => {
        throw new Error("boom");
      },
      "stonkfun_unreadable",
    ],
  ])("%s → gagal tertutup: tidak deploy, reserve tetap menabung", async (_n, read, issue) => {
    const s = setup();
    const a = await seedToken(s, "RSVP", 100_000n);
    await claimAll(s, 100_000n);
    const res = await mainnetWorker(s, { read }).run();
    expect(res.failed).toBe(0);
    expect(await deploys(a)).toHaveLength(0);
    // Pemindahan ke kustodi token itu sendiri tetap jalan: menabung tidak butuh harga.
    expect(await position(a)).toMatchObject({ balance: 20_000n, inVault: 20_000n });
    const d = await lastDecision(a);
    expect(d.allowed).toBe(false);
    expect(d.amount.toFixed(0)).toBe("0");
    expect(d.reasons.join(" ")).toContain("not verified");
    expect(d.reasons.join(" ")).not.toContain("below the $");
    expect(d.inputSnapshot).toMatchObject({
      quoteUsd: null,
      poolLiquidityUsd: null,
      reserveBalanceUsd: null,
      quoteUsdSource: "stonkfun_jupiter",
      quoteUsdIssues: expect.arrayContaining([issue]),
      failedSafetyChecks: expect.arrayContaining(["price_data_reliable"]),
    });
  });

  describe("quote selain SOL", () => {
    const QUOTE = { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", configId: "CfgUsdc" };
    const workerWith = (s: ReturnType<typeof setup>, read: () => Promise<SolPriceSnapshot>) =>
      new ReserveWorker({
        db,
        engine: s.engine(),
        chain: s.chain,
        cluster: "mainnet-beta",
        platform: PLATFORM,
        settings: { config: TEST_RESERVE, intervalMs: 1, minFundRaw: { default: "1" } },
        // Harga SOL sengaja berbeda: harga SOL tidak boleh dipakai untuk quote lain.
        solPrice: { read: async () => snapshot({ usd: 95 }) },
        quotePrices: { read },
        logger: silent,
        now: s.clock.now,
      });

    it("tanpa harga terverifikasi → ditahan dengan bukti alasannya, bukan memakai harga SOL", async () => {
      await saveQuoteAsset(db, "mainnet-beta", {
        mint: QUOTE.mint,
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
        raiseRaw: "8041995940",
      });
      const s = setup();
      const a = await seedToken(s, "RSVQ", 100_000n, true, QUOTE);
      const read = async () => snapshot({ ...UNVERIFIED, issues: ["jupiter_unreadable"] });
      await workerWith(s, read).run();
      const d = await lastDecision(a);
      expect(d.allowed).toBe(false);
      expect(d.inputSnapshot).toMatchObject({
        quoteUsd: null,
        reserveBalanceUsd: null,
        quoteUsdIssues: ["jupiter_unreadable"],
      });
    });

    it("harga terverifikasi quote itu sendiri yang dipakai", async () => {
      await saveQuoteAsset(db, "mainnet-beta", {
        mint: QUOTE.mint,
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
        raiseRaw: "8041995940",
      });
      const s = setup();
      const a = await seedToken(s, "RSVU", 100_000n, true, QUOTE);
      const asked: string[] = [];
      const worker = new ReserveWorker({
        db,
        engine: s.engine(),
        chain: s.chain,
        cluster: "mainnet-beta",
        platform: PLATFORM,
        settings: { config: TEST_RESERVE, intervalMs: 1, minFundRaw: { default: "1" } },
        solPrice: { read: async () => snapshot({ usd: 95 }) },
        quotePrices: {
          read: async (mint) => {
            asked.push(mint);
            return snapshot({ usd: 0.9995 });
          },
        },
        logger: silent,
        now: s.clock.now,
      });
      await worker.run();
      expect(asked).toContain(QUOTE.mint);
      expect((await lastDecision(a)).inputSnapshot).toMatchObject({ quoteUsd: 0.9995 });
    });

    it("quote tidak dikenal → dilewati: desimal tidak ditebak dan tidak ada keputusan", async () => {
      const s = setup();
      const unknown = { mint: key(), configId: "CfgTidakDikenal" };
      const a = await seedToken(s, "RSVX", 100_000n, true, unknown);
      const res = await workerWith(s, async () => snapshot({ usd: 1 })).run();
      expect(res.skipped).toContainEqual({ target: a, reason: "pair tidak dikenal" });
      expect(await db.reserveDecision.count({ where: { tokenMint: a } })).toBe(0);
    });
  });

  it("sumber harga tidak dipasang di mainnet → tidak pernah deploy", async () => {
    const s = setup();
    const a = await seedToken(s, "RSVN", 100_000n);
    await claimAll(s, 100_000n);
    await mainnetWorker(s, null).run();
    expect(await deploys(a)).toHaveLength(0);
    expect((await lastDecision(a)).allowed).toBe(false);
  });

  it("harga terverifikasi tetapi lebih tua dari batas reserve → ditahan", async () => {
    const s = setup();
    const a = await seedToken(s, "RSVO", 100_000n);
    await claimAll(s, 100_000n);
    const read = async () => snapshot({ ageSeconds: RESERVE_CONFIG.maxPriceAgeSeconds + 1 });
    await mainnetWorker(s, { read }).run();
    expect(await deploys(a)).toHaveLength(0);
    expect((await lastDecision(a)).inputSnapshot).toMatchObject({
      failedSafetyChecks: expect.arrayContaining(["price_data_reliable"]),
    });
  });

  it("harga terverifikasi: threshold $250 dinilai dengan harga asli, lalu deploy", async () => {
    const s = setup();
    const a = await seedToken(s, "RSVQ", 100_000n);
    await claimAll(s, 100_000n);
    // 20.000 lamport × $95 jauh di bawah $250 → tertahan oleh threshold, bukan oleh harga.
    const read = async () => snapshot({});
    await mainnetWorker(s, { read }, { ...TEST_RESERVE, minBalanceToDeployUsd: 250 }).run();
    expect(await deploys(a)).toHaveLength(0);
    const held = await lastDecision(a);
    expect(held.reasons.join(" ")).toContain("below the $250");
    expect(held.inputSnapshot).toMatchObject({ quoteUsd: 95, priceSource: "pool_onchain" });

    s.clock.advance(1_000);
    await mainnetWorker(s, { read }).run();
    const deploy = (await deploys(a))[0]!;
    expect(deploy.status).toBe("confirmed");
    const ok = await lastDecision(a);
    expect(ok.allowed).toBe(true);
    expect(ok.inputSnapshot).toMatchObject({
      quoteUsd: 95,
      quoteUsdSource: "stonkfun_jupiter",
      quoteUsdDeviationBps: 5,
      quoteUsdIssues: [],
    });
    // Nilai USD dari harga asli, bukan harga asumsi devnet ($150).
    const snap = ok.inputSnapshot as { poolLiquidityUsd: number };
    expect(snap.poolLiquidityUsd).toBeCloseTo(95);
  });
});

describe("Conviction Reserve worker", () => {
  it("FEE_SPENDING_ENABLED mati: reserve tercatat, tidak dipindah dan tidak dideploy", async () => {
    const s = setup(TEST_RESERVE, { feeSpendingEnabled: false });
    const a = await seedToken(s, "RSVH", 100_000n);
    await claimAll(s, 100_000n);
    const res = await s.worker().run();
    expect(res.created).toBe(0);
    expect(await db.economicOp.count({ where: { kind: "reserve_fund", tokenMint: a } })).toBe(0);
    expect(await deploys(a)).toHaveLength(0);
    expect((await reserveBalances(db, { tokenMint: a }))[0]?.claimed).toBe(20_000n);
  });

  it("kustodi per token → deployment 25% + burn LP terverifikasi; token belum graduate tidak disentuh", async () => {
    const s = setup();
    const a = await seedToken(s, "RSVA", 100_000n);
    const b = await seedToken(s, "RSVB", 50_000n, false);
    await claimAll(s, 150_000n);

    const res = await s.worker().run();
    expect(res).toMatchObject({ failed: 0, blocked: null });

    // A: 20.000 reserve → kustodi → deploy 25% = 5.000 (swap 2.500 + deposit ≤ 2.500).
    const deploy = (await deploys(a))[0]!;
    expect(deploy.status).toBe("confirmed");
    expect(deploy.amountIn?.toFixed(0)).toBe("5000");
    const proof = await db.reserveDeployment.findUniqueOrThrow({ where: { opId: deploy.id } });
    expect(proof).toMatchObject({ lockVerified: true, lockMethod: "burn", tokenMint: a });
    expect(proof.lpBurnedRaw.toFixed(0)).toBe(proof.lpMintedRaw.toFixed(0));
    expect(proof.reserveBeforeRaw.toFixed(0)).toBe("20000");
    expect(proof.quoteDeployedRaw.toFixed(0)).toBe("4999");
    expect(proof.remainingReserveRaw.toFixed(0)).toBe("15001");
    const ledger = await db.reserveLedger.findMany({
      where: { tokenMint: a, entryType: "deployment" },
    });
    expect(ledger.map((l) => l.amount.toFixed(0))).toEqual(["4999"]);
    expect(await position(a)).toMatchObject({ balance: 15_001n, inVault: 15_001n, inMaster: 0n });
    const vaultA = s.chain.vault(a).quoteAccount;
    expect(await s.chain.tokenBalance(vaultA)).toBe(15_001n);

    // B belum graduate: reserve dipindah ke kustodinya sendiri, tidak pernah dideploy.
    expect(await deploys(b)).toHaveLength(0);
    expect(await position(b)).toMatchObject({ balance: 10_000n, inVault: 10_000n });
    expect(await s.chain.tokenBalance(s.chain.vault(b).quoteAccount)).toBe(10_000n);
    expect(await s.worker().reconcileVaults()).toEqual(
      expect.arrayContaining([expect.objectContaining({ tokenMint: a, ok: true })]),
    );
  });

  it("cooldown 24 jam: siklus berikutnya tidak deploy lagi; setelah 24 jam boleh", async () => {
    const s = setup();
    const a = await seedToken(s, "RSVC", 100_000n);
    await claimAll(s, 100_000n);
    await s.worker().run();
    expect(await deploys(a)).toHaveLength(1);

    s.clock.advance(23 * 60 * 60 * 1000);
    const again = await s.worker().run();
    expect(again.created).toBe(0);
    expect(again.skipped.map((x) => x.reason).join(" ")).toMatch(/Cooldown/);
    expect(await deploys(a)).toHaveLength(1);
    const decision = await db.reserveDecision.findFirstOrThrow({
      where: { tokenMint: a },
      orderBy: { createdAt: "desc" },
    });
    expect(decision.allowed).toBe(false);

    s.clock.advance(2 * 60 * 60 * 1000);
    await s.worker().run();
    expect((await deploys(a)).filter((d) => d.status === "confirmed")).toHaveLength(2);
  });

  it("safety check gagal (dampak harga abnormal / threshold $250 / pool nonaktif) → tidak deploy", async () => {
    const s = setup();
    const a = await seedToken(s, "RSVD", 100_000n);
    await claimAll(s, 100_000n);
    s.chain.priceImpactBps = 900; // > maxPriceImpactBps 150
    const res = await s.worker().run();
    expect(res.created).toBe(1); // hanya reserve_fund
    expect(await deploys(a)).toHaveLength(0);
    const d = await db.reserveDecision.findFirstOrThrow({ where: { tokenMint: a } });
    expect(d.allowed).toBe(false);
    expect((d.inputSnapshot as { failedSafetyChecks: string[] }).failedSafetyChecks).toContain(
      "pool_state_normal",
    );

    // Default Spec $250: reserve ≈ $0,003 → reserve_sufficient gagal.
    s.chain.priceImpactBps = 50;
    const spec = setup(RESERVE_CONFIG);
    spec.chain.reservePools = s.chain.reservePools;
    spec.chain.balances = s.chain.balances;
    spec.chain.existing = s.chain.existing;
    await spec.worker().run();
    expect(await deploys(a)).toHaveLength(0);
    const d2 = await db.reserveDecision.findFirstOrThrow({
      where: { tokenMint: a },
      orderBy: { createdAt: "desc" },
    });
    expect((d2.inputSnapshot as { failedSafetyChecks: string[] }).failedSafetyChecks).toEqual([
      "reserve_sufficient",
    ]);

    s.chain.reservePools.set(a, { ...s.chain.reservePools.get(a)!, swapEnabled: false });
    await s.worker().run();
    expect(await deploys(a)).toHaveLength(0);
  });

  it("signer dipause → tertahan tanpa transaksi; setelah resume deploy sekali", async () => {
    const s = setup();
    const a = await seedToken(s, "RSVE", 100_000n);
    await claimAll(s, 100_000n);
    s.signer.paused = true;
    const sentBefore = s.sender.sent;
    const res = await s.worker().run();
    expect(res.blocked).not.toBeNull();
    expect(s.sender.sent).toBe(sentBefore);
    const pending = await db.economicOp.findMany({
      where: { kind: { in: ["reserve_fund", "reserve_deploy"] }, tokenMint: a },
    });
    expect(pending.every((o) => o.status === "pending" && o.signature === null)).toBe(true);

    s.signer.paused = false;
    await s.worker().run();
    await s.worker().run();
    expect((await deploys(a)).filter((d) => d.status === "confirmed")).toHaveLength(1);
  });

  it("restart di tengah deploy: transaksi bertanda tangan yang SAMA dikirim ulang, tanpa deploy ganda", async () => {
    const s = setup();
    const b = await seedToken(s, "RSVG", 100_000n);
    await claimAll(s, 100_000n);
    const pool = s.chain.reservePools.get(b)!;
    s.chain.reservePools.delete(b); // siklus 1: hanya pindah ke kustodi
    await s.worker().run();
    s.chain.reservePools.set(b, pool);
    s.sender.drop = 2; // deploy ditandatangani & disimpan, tetapi tidak mendarat (worker mati)
    const first = await s.worker().run();
    expect(first.created).toBe(1);
    const [op] = await deploys(b);
    expect(op!.status).toBe("submitted");
    expect(op!.signature).not.toBeNull();

    // Proses baru (restart): operasi aktif dilanjutkan dengan transaksi & signature yang sama.
    await s.worker(s.engine()).run();
    await s.worker(s.engine()).run();
    const ops = await deploys(b);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.status).toBe("confirmed");
    expect(ops[0]!.signature).toBe(op!.signature);
    expect(s.signer.requests.filter((r) => r.opId === op!.id)).toHaveLength(1);
    expect(await db.reserveDeployment.count({ where: { tokenMint: b } })).toBe(1);
  });

  it("double-run: dua proses bersamaan (lease + index unik) → satu deployment per token", async () => {
    const s = setup();
    const a = await seedToken(s, "RSVH", 100_000n);
    await claimAll(s, 100_000n);
    const run = (owner: string) =>
      runWorkerCycle("economic:reserve", {
        db,
        engine: s.engine(),
        chain: s.chain,
        platform: PLATFORM,
        owner,
        leaseMs: 60_000,
        logger: silent,
        lowMasterBalanceLamports: 0n,
        alertConsecutiveFailures: 3,
        reserve: s.worker(),
      });
    await Promise.all([run("w1"), run("w2"), s.worker().run()]);
    await run("w3");
    expect((await deploys(a)).filter((d) => d.status === "confirmed")).toHaveLength(1);
    expect(await db.reserveDeployment.count({ where: { tokenMint: a } })).toBe(1);
  });

  it("reserve token lain tidak pernah dipakai: batas deploy dari saldo kustodi token itu sendiri", async () => {
    const s = setup();
    const rich = await seedToken(s, "RICH", 1_000_000n);
    const poor = await seedToken(s, "POOR", 5n);
    await claimAll(s, 1_000_005n);
    await s.worker().run();
    expect(await deploys(poor)).toHaveLength(0);
    expect(await position(poor)).toMatchObject({ inVault: 1n, deployed: 0n });
    const richDeploy = (await deploys(rich))[0]!;
    expect(richDeploy.amountIn?.toFixed(0)).toBe("50000"); // 25% × 200.000
    expect(await s.chain.tokenBalance(s.chain.vault(poor).quoteAccount)).toBe(1n);
  });

  it("burn LP tidak lengkap → deployment tercatat tetapi lock TIDAK terverifikasi", async () => {
    const s = setup();
    const a = await seedToken(s, "RSVI", 100_000n);
    await claimAll(s, 100_000n);
    s.chain.lpBurnShortfall = 1n;
    await s.worker().run();
    const proof = await db.reserveDeployment.findFirstOrThrow({ where: { tokenMint: a } });
    expect(proof.lockVerified).toBe(false);
  });
});
