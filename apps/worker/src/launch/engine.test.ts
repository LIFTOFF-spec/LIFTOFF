import { createPrismaClient, type Db } from "@liftoff/db";
import { prepareTestDatabase, RESETTABLE_TABLES } from "@liftoff/db/testing";
import {
  LAUNCH_ENGINE,
  launchFingerprint,
  pairsFor,
  StaticStonkFunAdapter,
  type LaunchTimelineEntry,
  type StonkFunPair,
} from "@liftoff/shared";
import { pairForToken } from "@liftoff/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LaunchEngine } from "./engine";
import { CrashError, FakeLedger, FakeSender, FakeSigner } from "./fakes";
import { SignerClientError } from "./ports";

const SOL = pairsFor("devnet").find((p) => p.id === "sol")!;
let db: Db;

beforeAll(async () => {
  db = createPrismaClient(await prepareTestDatabase("liftoff_test_worker"));
});
beforeEach(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE ${RESETTABLE_TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
});
afterAll(async () => {
  await db.$disconnect();
});

let seq = 0;
async function seedQueuedJob(
  opts: {
    withX?: boolean;
    deposit?: boolean;
    fingerprint?: string | null;
    quote?: { mint: string; configId: string };
  } = {},
) {
  seq++;
  const user = await db.user.create({
    data: {
      wallet: `Wallet${seq}${Date.now()}`,
      ...(opts.withX ? { xUserId: `x${seq}`, xHandle: `h${seq}` } : {}),
    },
  });
  const ticker = `T${seq}`;
  const token = await db.token.create({
    data: {
      name: `Token ${seq}`,
      ticker,
      tickerNormalized: ticker.toLowerCase(),
      quoteMint: opts.quote?.mint ?? SOL.mint,
      quoteConfigId: opts.quote?.configId ?? SOL.configId,
      creatorUserId: user.id,
      launchStatus: "queued",
    },
  });
  await db.tickerClaim.create({
    data: { tickerNormalized: token.tickerNormalized, tokenId: token.id },
  });
  if (opts.withX)
    await db.xAccountClaim.create({ data: { xUserId: `x${seq}`, tokenId: token.id } });
  const job = await db.launchJob.create({
    data: {
      tokenId: token.id,
      userId: user.id,
      idempotencyKey: `idem-${seq}-${Date.now()}`,
      requestHash: "h",
      status: "queued",
      timeline: [{ status: "queued", at: new Date().toISOString() }],
      configFingerprint: opts.fingerprint ?? null,
    },
  });
  if (opts.deposit) {
    await db.launchDeposit.create({
      data: {
        jobId: job.id,
        depositSignature: `dep-${seq}`,
        payer: user.wallet,
        lamports: 100_000_000,
      },
    });
  }
  return job;
}

function harness(overrides: Partial<typeof LAUNCH_ENGINE> = {}) {
  const ledger = new FakeLedger();
  const sender = new FakeSender(ledger);
  const signer = new FakeSigner();
  const stonkfun = new StaticStonkFunAdapter();
  let clock = 0;
  const make = (opts: { crashOnSleep?: boolean } = {}) =>
    new LaunchEngine({
      db,
      chain: ledger,
      signer,
      sender,
      cluster: "devnet",
      config: { ...LAUNCH_ENGINE, confirmWaitMs: 10_000_000, ...overrides },
      stonkfun,
      metadataUri: (id) => `https://api.test/metadata/${id}.json`,
      // Waktu palsu: sleep memajukan jam, tanpa menunggu sungguhan.
      sleep: async (ms) => {
        // crashOnSleep: proses worker "mati" saat menunggu konfirmasi.
        if (opts.crashOnSleep) throw new CrashError();
        clock += ms;
      },
      now: () => clock,
    });
  return { ledger, sender, signer, stonkfun, engine: make(), make };
}

async function state(jobId: string) {
  const job = await db.launchJob.findUniqueOrThrow({
    where: { id: jobId },
    include: { token: { include: { tickerClaims: true, xClaims: true } }, transactions: true },
  });
  const timeline = (job.timeline as unknown as LaunchTimelineEntry[]).map((t) => t.status);
  return { job, timeline };
}

describe("launch engine — jalur normal", () => {
  it("queued → submitting → confirming → live; mint dipublikasikan hanya saat live", async () => {
    const h = harness();
    const job = await seedQueuedJob({ withX: true });
    expect(await h.engine.run(job.id)).toEqual({ kind: "final", status: "live" });
    const { job: j, timeline } = await state(job.id);
    expect(timeline).toEqual(["queued", "submitting", "confirming", "live"]);
    expect(j.token.launchStatus).toBe("live");
    expect(j.token.mint).toBe(j.mintAddress);
    expect(j.poolAddress).toBe(`pool-${j.mintAddress}`);
    expect(j.createSignature).toBe(j.transactions[0]!.signature);
    expect(j.transactions[0]!.confirmationStatus).toBe("confirmed");
    expect(j.submissionCount).toBe(1);
    expect(j.token.tickerClaims[0]!.status).toBe("active");
    expect(h.ledger.createsLanded).toBe(1);
    const audit = await db.auditEvent.findMany({
      where: { action: "launch.live", txSignature: j.createSignature },
    });
    expect(audit).toHaveLength(1);
  });

  it("run kedua pada job live tidak mengirim apa pun", async () => {
    const h = harness();
    const job = await seedQueuedJob();
    await h.engine.run(job.id);
    await h.engine.run(job.id);
    expect(h.sender.sent).toBe(1);
    expect(h.signer.signed).toBe(1);
  });
});

describe("launch engine — kegagalan tanpa launch ganda", () => {
  it("RPC timeout saat kirim, transaksi tetap mendarat → live tanpa kirim ulang", async () => {
    const h = harness();
    h.sender.behaviors = ["timeout_land"];
    const job = await seedQueuedJob();
    expect(await h.engine.run(job.id)).toMatchObject({ status: "live" });
    expect(h.sender.sent).toBe(1);
    expect(h.ledger.createsLanded).toBe(1);
  });

  it("RPC timeout saat kirim dan transaksi hilang → kirim ulang dengan mint SAMA → live", async () => {
    const h = harness();
    h.sender.behaviors = ["timeout_drop", "land"];
    const job = await seedQueuedJob();
    expect(await h.engine.run(job.id)).toMatchObject({ status: "live" });
    const { job: j, timeline } = await state(job.id);
    expect(h.ledger.builds.map((b) => b.mint)).toEqual([j.mintAddress, j.mintAddress]);
    expect(j.submissionCount).toBe(2);
    expect(timeline).toEqual([
      "queued",
      "submitting",
      "confirming",
      "submitting",
      "confirming",
      "live",
    ]);
    expect(h.ledger.createsLanded).toBe(1);
  });

  it("RPC timeout saat memantau → error ke BullMQ (retry), status tidak rusak, run berikutnya live", async () => {
    const h = harness();
    h.sender.behaviors = ["drop", "land"];
    const job = await seedQueuedJob();
    // Kirim pertama hilang; panggilan RPC berikutnya (pemantauan) timeout.
    h.ledger.validity = 1_000_000; // transaksi belum kedaluwarsa → engine terus memantau
    const send = h.sender.send.bind(h.sender);
    h.sender.send = async (signed) => {
      const res = await send(signed);
      if (h.sender.sent === 1) h.ledger.failNextCalls = 1;
      return res;
    };
    await expect(h.make().run(job.id)).rejects.toThrow(/RPC tidak merespons/);
    expect((await state(job.id)).job.status).toBe("confirming");
    h.ledger.validity = 150;
    h.ledger.height += 2_000_000; // transaksi pertama kini kedaluwarsa
    expect(await h.make().run(job.id)).toMatchObject({ status: "live" });
    expect(h.ledger.createsLanded).toBe(1);
  });

  it("transaksi tidak pernah mendarat → failed setelah maxSubmissions, klaim dilepas", async () => {
    const h = harness({ maxSubmissions: 3 });
    h.sender.behaviors = ["drop"];
    const job = await seedQueuedJob({ withX: true });
    expect(await h.engine.run(job.id)).toEqual({ kind: "final", status: "failed" });
    const { job: j } = await state(job.id);
    expect(j.submissionCount).toBe(3);
    expect(new Set(h.ledger.builds.map((b) => b.mint)).size).toBe(1);
    expect(j.token.mint).toBeNull();
    expect(j.token.launchStatus).toBe("failed");
    expect(j.lastError).toMatch(/did not land after 3 attempts/);
    expect(j.token.tickerClaims.every((c) => c.status === "released")).toBe(true);
    expect(j.token.xClaims.every((c) => c.status === "released")).toBe(true);
    expect(h.ledger.createsLanded).toBe(0);
  });

  it("signer dipause → kembali ke queued tanpa transaksi; setelah resume → live", async () => {
    const h = harness();
    h.signer.paused = true;
    const job = await seedQueuedJob();
    expect(await h.engine.run(job.id)).toMatchObject({ kind: "paused" });
    let s = await state(job.id);
    expect(s.job.status).toBe("queued");
    expect(s.job.transactions).toHaveLength(0);
    expect(s.job.lastError).toMatch(/paused/);
    expect(s.job.token.tickerClaims[0]!.status).toBe("active");
    expect(h.sender.sent).toBe(0);
    h.signer.paused = false;
    expect(await h.engine.run(job.id)).toMatchObject({ status: "live" });
    s = await state(job.id);
    expect(s.timeline).toEqual([
      "queued",
      "submitting",
      "queued",
      "submitting",
      "confirming",
      "live",
    ]);
    expect(s.job.lastError).toBeNull();
  });

  it("worker restart setelah sign sebelum mencatat → transaksi tak pernah terkirim, run baru mengirim sekali", async () => {
    const h = harness();
    h.signer.crashAfterSign = true;
    const job = await seedQueuedJob();
    await expect(h.make().run(job.id)).rejects.toBeInstanceOf(CrashError);
    expect((await state(job.id)).job.status).toBe("submitting");
    expect(await h.make().run(job.id)).toMatchObject({ status: "live" });
    expect(h.sender.sent).toBe(1);
    expect(h.ledger.createsLanded).toBe(1);
  });

  it("worker restart setelah transaksi mendarat (sebelum konfirmasi tercatat) → live tanpa kirim ulang", async () => {
    const h = harness();
    const job = await seedQueuedJob();
    await expect(h.make({ crashOnSleep: true }).run(job.id)).rejects.toBeInstanceOf(CrashError);
    expect((await state(job.id)).job.status).toBe("confirming");
    expect(await h.make().run(job.id)).toMatchObject({ status: "live" });
    expect(h.sender.sent).toBe(1);
    expect((await state(job.id)).job.submissionCount).toBe(1);
  });

  it("dua worker memproses job yang sama bersamaan → tetap satu launch", async () => {
    const h = harness();
    const job = await seedQueuedJob();
    const results = await Promise.allSettled([h.make().run(job.id), h.make().run(job.id)]);
    expect(results.some((r) => r.status === "fulfilled" && r.value.kind === "final")).toBe(true);
    await h.make().run(job.id);
    expect((await state(job.id)).job.status).toBe("live");
    expect(h.ledger.createsLanded).toBe(1);
  });

  it("transaksi lama mendarat terlambat saat kirim ulang → create kedua gagal on-chain, tetap satu launch", async () => {
    const h = harness();
    const job = await seedQueuedJob();
    // Kirim pertama "hilang" tetapi kita simpan untuk didaratkan belakangan.
    let late: string | null = null;
    h.sender.send = async (signed: string) => {
      h.sender.sent++;
      if (late === null) {
        late = signed;
        // Worker menganggap transaksi ini kedaluwarsa (mis. RPC melaporkan block height maju).
        await db.transaction.updateMany({
          where: { jobId: job.id },
          data: { lastValidBlockHeight: 0n },
        });
        return { signature: "x", bundleId: null };
      }
      h.ledger.land(late); // yang lama mendarat dulu (sebelum kedaluwarsa dalam dunia nyata)
      h.ledger.land(signed); // create kedua untuk mint yang sama → gagal on-chain
      return { signature: "y", bundleId: null };
    };
    h.ledger.validity = 100_000_000; // biarkan keduanya "masih berlaku"
    expect(await h.make().run(job.id)).toMatchObject({ status: "live" });
    expect(h.sender.sent).toBe(2);
    expect(h.ledger.createsLanded).toBe(1);
    expect(h.ledger.createsFailedOnchain).toBe(1);
  });

  it("simulasi ditolak permanen → failed, klaim dilepas, tidak ada transaksi", async () => {
    const h = harness();
    h.signer.nextError = new SignerClientError(
      "simulation_failed",
      "simulasi gagal: Custom 6002",
      false,
    );
    const job = await seedQueuedJob();
    expect(await h.engine.run(job.id)).toMatchObject({ status: "failed" });
    const { job: j } = await state(job.id);
    expect(j.transactions).toHaveLength(0);
    expect(j.token.tickerClaims[0]!.status).toBe("released");
  });

  it("signer tidak terjangkau (retryable) → error ke BullMQ, job tetap submitting", async () => {
    const h = harness();
    h.signer.nextError = new SignerClientError("network", "connect ECONNREFUSED", true);
    const job = await seedQueuedJob();
    await expect(h.engine.run(job.id)).rejects.toThrow(/ECONNREFUSED/);
    expect((await state(job.id)).job.status).toBe("submitting");
    expect(await h.make().run(job.id)).toMatchObject({ status: "live" });
  });

  it("mendarat tetapi pool belum terverifikasi → needs_reconciliation, lalu live setelah terverifikasi", async () => {
    const h = harness({ confirmWaitMs: 5_000 });
    h.ledger.hidePool = true;
    const job = await seedQueuedJob();
    const first = await h.make().run(job.id);
    expect(first).toMatchObject({ kind: "pending", status: "needs_reconciliation" });
    expect((await state(job.id)).job.token.mint).toBeNull();
    h.ledger.hidePool = false;
    expect(await h.make().run(job.id)).toMatchObject({ status: "live" });
    expect(h.sender.sent).toBe(1);
    expect((await state(job.id)).timeline).toEqual([
      "queued",
      "submitting",
      "confirming",
      "needs_reconciliation",
      "live",
    ]);
  });

  it("deposit launch dikembalikan jika gagal permanen, disimpan jika live", async () => {
    const h = harness({ maxSubmissions: 1 });
    h.sender.behaviors = ["drop", "land"];
    const failing = await seedQueuedJob({ deposit: true });
    expect(await h.engine.run(failing.id)).toMatchObject({ status: "failed" });
    let dep = await db.launchDeposit.findUniqueOrThrow({ where: { jobId: failing.id } });
    expect(dep.status).toBe("refund_pending");
    expect(dep.refundSignature).not.toBeNull();
    // Refund mendarat (sender "land"); run berikutnya (sweeper) menandai refunded.
    await h.engine.run(failing.id);
    dep = await db.launchDeposit.findUniqueOrThrow({ where: { jobId: failing.id } });
    expect(dep.status).toBe("refunded");

    const h2 = harness();
    const ok = await seedQueuedJob({ deposit: true });
    await h2.engine.run(ok.id);
    expect((await db.launchDeposit.findUniqueOrThrow({ where: { jobId: ok.id } })).status).toBe(
      "kept",
    );
  });
});

describe("launch engine — pair di luar registri", () => {
  const quote = { mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", configId: "CfgSpyx" };

  function withPair(h: ReturnType<typeof harness>, over: Partial<StonkFunPair> = {}) {
    h.stonkfun.pairs.push({
      ...h.stonkfun.pairs[0]!,
      id: `sf-${quote.mint}`,
      symbol: "SPYX",
      name: "SP500",
      decimals: 8,
      assumedPriceUsd: 700,
      ...quote,
      ...over,
    });
  }

  it("simbol, desimal & raise masuk katalog sebelum tanda tangan; launch memakai pair itu", async () => {
    const h = harness();
    withPair(h);
    const job = await seedQueuedJob({ quote });
    expect(await h.engine.run(job.id)).toEqual({ kind: "final", status: "live" });
    const row = await db.quoteAsset.findUniqueOrThrow({ where: { mint: quote.mint } });
    expect(row).toMatchObject({ symbol: "SPYX", name: "SP500", decimals: 8 });
    expect(BigInt(row.raiseRaw!)).toBeGreaterThan(0n);
    expect(h.ledger.builds.at(-1)!.pricing.quoteMint).toBe(quote.mint);
    expect(pairForToken("devnet", { quoteMint: quote.mint, quoteConfigId: "X" })).toMatchObject({
      symbol: "SPYX",
      decimals: 8,
    });
  });

  it("pair berhenti tersedia sesudah validasi → gagal aman dengan alasannya, tanpa transaksi", async () => {
    const h = harness();
    withPair(h, {
      launchLabReady: false,
      unavailableReason: "Quote mints with a transfer hook are not supported.",
    });
    const job = await seedQueuedJob({ quote });
    expect(await h.engine.run(job.id)).toEqual({ kind: "final", status: "failed" });
    const { job: j } = await state(job.id);
    expect(j.lastError).toMatch(/transfer hook/);
    expect(j.transactions).toHaveLength(0);
  });
});

describe("launch engine — config StonkFun (Spec §4: gagal aman)", () => {
  async function fingerprintOf(adapter: StaticStonkFunAdapter) {
    const [list, cfg] = await Promise.all([adapter.listPairs(), adapter.activeLaunchConfig()]);
    return launchFingerprint(
      cfg,
      list.pairs.find((p) => p.configId === SOL.configId)!,
    );
  }

  it("sidik jari sama → launch jalan", async () => {
    const h = harness();
    const job = await seedQueuedJob({ fingerprint: await fingerprintOf(h.stonkfun) });
    expect(await h.engine.run(job.id)).toEqual({ kind: "final", status: "live" });
  });

  it("config berubah sejak validasi → failed sebelum menandatangani; klaim dilepas", async () => {
    const h = harness();
    const job = await seedQueuedJob({ fingerprint: await fingerprintOf(h.stonkfun) });
    h.stonkfun.config.creatorFeeRate = 0; // operator/StonkFun mengubah fee
    expect(await h.engine.run(job.id)).toEqual({ kind: "final", status: "failed" });
    const { job: j } = await state(job.id);
    expect(j.lastError).toMatch(/configuration changed/);
    expect(j.transactions).toHaveLength(0);
    expect(h.ledger.createsLanded).toBe(0);
    expect(j.token.tickerClaims[0]!.status).toBe("released");
  });

  it("sidik jari dengan pricing (raise, curve-rule, Token-2022) → launch jalan; builder menerima pricing", async () => {
    const h = harness();
    const [list, cfg] = await Promise.all([
      h.stonkfun.listPairs(),
      h.stonkfun.activeLaunchConfig(),
    ]);
    const pair = list.pairs.find((p) => p.configId === SOL.configId)!;
    const pricing = await h.stonkfun.launchPricing(pair);
    const job = await seedQueuedJob({ fingerprint: launchFingerprint(cfg, pair, pricing) });
    expect(await h.engine.run(job.id)).toEqual({ kind: "final", status: "live" });
    expect(h.ledger.builds.at(-1)!.pricing).toMatchObject({
      baseTokenProgram: "token2022",
      baseDecimals: 6,
      configId: SOL.configId,
      totalFundRaisingB: pair.graduationRaw,
    });
  });

  it("pricing tidak memenuhi syarat adopsi StonkFun (base SPL) → failed sebelum menandatangani", async () => {
    const h = harness();
    h.stonkfun.baseTokenProgram = "spl";
    const job = await seedQueuedJob({ fingerprint: await fingerprintOf(h.stonkfun) });
    expect(await h.engine.run(job.id)).toEqual({ kind: "final", status: "failed" });
    const { job: j } = await state(job.id);
    expect(j.lastError).toMatch(/would not adopt.*Token-2022/);
    expect(j.transactions).toHaveLength(0);
  });

  it("pair tidak lagi tersedia → failed dengan alasan", async () => {
    const h = harness();
    const job = await seedQueuedJob({ fingerprint: await fingerprintOf(h.stonkfun) });
    const sol = h.stonkfun.pairs.find((p) => p.configId === SOL.configId)!;
    sol.launchable = false;
    sol.unavailableReason = "Pair removed.";
    expect(await h.engine.run(job.id)).toEqual({ kind: "final", status: "failed" });
    expect((await state(job.id)).job.lastError).toMatch(/Pair removed/);
  });
});
