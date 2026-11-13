import { randomBytes } from "node:crypto";
import {
  buybackBudgets,
  createPrismaClient,
  recordTradeAndCreatorFee,
  reserveBalances,
  type Db,
} from "@liftoff/db";
import { prepareTestDatabase, RESETTABLE_TABLES } from "@liftoff/db/testing";
import { base58Encode, ECONOMIC_CONFIG, pairsFor, platformFor } from "@liftoff/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SignerClientError } from "../launch/ports";
import { EconomicEngine } from "./engine";
import { FakeEconomicChain, FakeEconomicSigner, FakeSender } from "./fakes";
import type { EconomicWorkerSettings } from "./ports";
import { fundsSnapshot } from "./runner";

const SOL = pairsFor("devnet").find((p) => p.id === "sol")!;
const PLATFORM = platformFor("devnet");
const MASTER = PLATFORM.masterWallet;
const silent = { info: () => {}, warn: () => {} };
const key = () => base58Encode(randomBytes(32));
const sig = () => base58Encode(randomBytes(64));
let db: Db;

beforeAll(async () => {
  db = createPrismaClient(await prepareTestDatabase("liftoff_test_worker"));
});
beforeEach(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE ${RESETTABLE_TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
  // economic_ops tidak bisa dihapus (trigger): operasi aktif dari test sebelumnya ditutup.
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
  minBuybackRaw: { default: "5000" },
  reconcileGraceMs: 60_000,
  retryBackoffMs: 60_000,
  graduatedRoute: "cpmm",
  feeIntake: "claim",
  forwarders: [],
  feeSpendingEnabled: true,
  confirmWaitMs: 0,
  confirmPollMs: 0,
};

class Clock {
  t = Date.now();
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
}

function setup(overrides: Partial<EconomicWorkerSettings> = {}) {
  const chain = new FakeEconomicChain(MASTER);
  // Vault palsu per test (ledger & operasi tidak dikosongkan antar test).
  const nonce = key().slice(0, 6);
  const origClaimable = chain.curveClaimable.bind(chain);
  chain.curveClaimable = async (q: string) => ({
    ...(await origClaimable(q)),
    vault: `vault-${nonce}`,
  });
  const signer = new FakeEconomicSigner();
  const sender = new FakeSender(chain);
  const clock = new Clock();
  const make = () =>
    new EconomicEngine({
      db,
      chain,
      signer,
      sender,
      cluster: "devnet",
      platform: PLATFORM,
      config: { ...SETTINGS, ...overrides },
      logger: silent,
      now: clock.now,
      sleep: async () => {},
    });
  return { chain, signer, sender, clock, engine: make(), make, vault: `vault-${nonce}` };
}

async function seedToken(ticker = "ECO") {
  const mint = key();
  const user = await db.user.create({ data: { wallet: key() } });
  await db.token.create({
    data: {
      name: ticker,
      ticker,
      tickerNormalized: ticker.toLowerCase(),
      mint,
      quoteMint: SOL.mint,
      quoteConfigId: SOL.configId,
      creatorUserId: user.id,
      launchStatus: "live",
    },
  });
  return mint;
}

let slot = 1_000;
/** Trade dengan creator fee (curve / CPMM) seperti yang dicatat indexer. */
async function trade(
  mint: string,
  fee: bigint,
  route: "launchlab" | "cpmm" = "launchlab",
  s?: number,
) {
  const signature = sig();
  await recordTradeAndCreatorFee(
    db,
    {
      signature,
      route,
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
      slot: s ?? slot++,
    },
    SOL.mint,
    { recordedBy: "indexer" },
  );
  return signature;
}

const budgetOf = async (mint: string) =>
  (await buybackBudgets(db, { tokenMint: mint })).find((b) => b.assetMint === SOL.mint);

describe("EconomicEngine — siklus penuh", () => {
  it("claim vault curve → verified → buyback token sendiri → burn terverifikasi; ulang = tanpa duplikat", async () => {
    const { chain, engine, signer, vault } = setup();
    const a = await seedToken("ECOA");
    const b = await seedToken("ECOB");
    await trade(a, 20_000n);
    await trade(b, 9_825n);
    chain.curveVaults.set(SOL.mint, 29_825n);
    chain.slot = 9_000; // claim mendarat sesudah semua trade

    const fee = await engine.runFeeProcessing();
    expect(fee).toMatchObject({ created: 1, confirmed: 1, failed: 0, blocked: null });
    const claim = await db.economicOp.findFirstOrThrow({
      where: { kind: "claim_curve", target: vault },
    });
    expect(claim.status).toBe("confirmed");
    expect(claim.amountOut?.toFixed(0)).toBe("29825");
    const rec = await db.feeReconciliation.findMany({ where: { claimOpId: claim.id } });
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ status: "verified" });
    expect(rec[0]!.differenceRaw.toFixed(0)).toBe("0");
    expect(await db.feeClaimItem.count({ where: { claimOpId: claim.id } })).toBe(2);
    expect((claim.details as { reconciled?: boolean }).reconciled).toBe(true);

    // 80/20: buyback 16.000 / 7.860; reserve 4.000 / 1.965 (claimed, terpisah per token).
    expect((await budgetOf(a))?.available).toBe(16_000n);
    expect((await budgetOf(b))?.available).toBe(7_860n);
    const reserves = await reserveBalances(db, { tokenMint: a });
    expect(reserves[0]).toMatchObject({ claimed: 4_000n, accrued: 4_000n });

    const bb = await engine.runBuyback();
    expect(bb).toMatchObject({ failed: 0, blocked: null });
    for (const [mint, spent] of [
      [a, 16_000n],
      [b, 7_860n],
    ] as const) {
      const buy = await db.economicOp.findFirstOrThrow({
        where: { kind: "buyback", tokenMint: mint },
      });
      expect(buy.status).toBe("confirmed");
      expect(buy.amountIn?.toFixed(0)).toBe(spent.toString());
      expect(buy.amountOut?.toFixed(0)).toBe((spent * 1_000n).toString());
      const burn = await db.economicOp.findFirstOrThrow({
        where: { kind: "burn", parentOpId: buy.id },
      });
      expect(burn.status).toBe("confirmed");
      const ledger = await db.burnLedger.findMany({ where: { tokenMint: mint } });
      expect(ledger).toHaveLength(1);
      expect(ledger[0]!.amountBurned.toFixed(0)).toBe((spent * 1_000n).toString());
      expect(ledger[0]!.amountSpent.toFixed(0)).toBe(spent.toString());
      expect(ledger[0]!.buybackSignature).toBe(buy.signature);
      expect(ledger[0]!.burnSignature).toBe(burn.signature);
      expect((await budgetOf(mint))?.available).toBe(0n);
      expect(await chain.tokenBalance(chain.ata(mint))).toBe(0n);
    }

    // Double-run / restart: siklus ulang tidak membuat claim, buyback, atau burn baru.
    const requests = signer.requests.length;
    expect(await engine.runFeeProcessing()).toMatchObject({ created: 0 });
    expect(await engine.runBuyback()).toMatchObject({ created: 0 });
    expect(signer.requests.length).toBe(requests);
    expect(chain.executed.filter((t) => t.kind === "buyback")).toHaveLength(2);
    expect(chain.executed.filter((t) => t.kind === "burn")).toHaveLength(2);
  });

  it("budget di bawah threshold tidak dieksekusi (batching)", async () => {
    const { chain, engine } = setup({ minBuybackRaw: { default: "100000" } });
    const a = await seedToken();
    await trade(a, 20_000n);
    chain.curveVaults.set(SOL.mint, 20_000n);
    chain.slot = 9_000;
    await engine.runFeeProcessing();
    const res = await engine.runBuyback();
    expect(res.created).toBe(0);
    expect(res.skipped.some((s) => s.target === a && /threshold/.test(s.reason))).toBe(true);
    expect((await budgetOf(a))?.available).toBe(16_000n);
  });

  it("claim pool CPMM per token (sesudah graduate) lalu buyback di CPMM", async () => {
    const { chain, engine } = setup();
    const a = await seedToken();
    const pool = key();
    await db.tokenGraduation.create({
      data: {
        tokenMint: a,
        state: "verified",
        launchPool: key(),
        cpmmPool: pool,
        checkedAt: new Date(),
      },
    });
    await trade(a, 12_500n, "cpmm");
    await trade(a, 132_266n, "cpmm");
    chain.pools.set(pool, {
      pool,
      poolCreator: MASTER,
      enableCreatorFee: true,
      mintA: SOL.mint,
      mintB: a,
      feesA: 144_766n,
      feesB: 0n,
    });
    chain.slot = 9_000;
    chain.route = "cpmm";
    await engine.runFeeProcessing();
    const claim = await db.economicOp.findFirstOrThrow({
      where: { kind: "claim_cpmm", target: pool },
    });
    expect(claim).toMatchObject({ status: "confirmed", tokenMint: a });
    const recs = await db.feeReconciliation.findMany({ where: { claimOpId: claim.id } });
    expect(recs.find((r) => r.assetMint === SOL.mint)).toMatchObject({ status: "verified" });
    expect((await budgetOf(a))?.available).toBe(115_813n);
    await engine.runBuyback();
    const buy = await db.economicOp.findFirstOrThrow({ where: { kind: "buyback", tokenMint: a } });
    expect(buy).toMatchObject({ status: "confirmed" });
    expect((buy.details as { route: string }).route).toBe("cpmm");
    expect(await db.burnLedger.count({ where: { tokenMint: a } })).toBe(1);
  });
});

describe("EconomicEngine — rekonsiliasi", () => {
  it("vault > ledger: menunggu indexer, lalu verified setelah trade tercatat", async () => {
    const { chain, engine, clock, vault } = setup();
    const a = await seedToken();
    await trade(a, 10_000n, "launchlab", 100);
    chain.curveVaults.set(SOL.mint, 15_000n);
    chain.slot = 9_000;
    const r1 = await engine.runFeeProcessing();
    expect(r1.confirmed).toBe(1);
    expect(r1.skipped.some((s) => /menunggu indexer/.test(s.reason))).toBe(true);
    expect((await budgetOf(a))?.available ?? 0n).toBe(0n); // belum di-claim = belum bisa dibelanjakan

    // Indexer menyusul: trade di slot sebelum claim tercatat.
    await trade(a, 5_000n, "launchlab", 200);
    clock.advance(1_000);
    await engine.runFeeProcessing();
    const claim = await db.economicOp.findFirstOrThrow({
      where: { kind: "claim_curve", target: vault },
    });
    expect(
      (await db.feeReconciliation.findFirstOrThrow({ where: { claimOpId: claim.id } })).status,
    ).toBe("verified");
    expect((await budgetOf(a))?.available).toBe(12_000n);
  });

  it("selisih setelah masa tunggu → estimated + correction; alokasi = fee yang benar-benar di-claim", async () => {
    const { chain, engine, clock, vault } = setup();
    const a = await seedToken("ESTA");
    const b = await seedToken("ESTB");
    await trade(a, 30_000n);
    await trade(b, 10_000n);
    chain.curveVaults.set(SOL.mint, 36_000n); // ledger 40.000 > claimed 36.000
    chain.slot = 9_000;
    await engine.runFeeProcessing();
    clock.advance(SETTINGS.reconcileGraceMs + 1);
    await engine.runFeeProcessing();
    const claim = await db.economicOp.findFirstOrThrow({
      where: { kind: "claim_curve", target: vault },
    });
    const rec = await db.feeReconciliation.findFirstOrThrow({ where: { claimOpId: claim.id } });
    expect(rec.status).toBe("estimated");
    expect(rec.differenceRaw.toFixed(0)).toBe("-4000");
    const corrections = await db.feeLedger.findMany({ where: { claimOpId: claim.id } });
    const sum = (bucket: string) =>
      corrections
        .filter((c) => c.bucket === bucket)
        .reduce((s, c) => s + BigInt(c.amount.toFixed(0)), 0n);
    expect(sum("received")).toBe(-4_000n);
    expect(
      corrections.every((c) => c.attribution === "estimated" && c.entryType === "correction"),
    ).toBe(true);
    // Pro-rata 3:1 → a −3.000, b −1.000. Budget + reserve per token = bagian claim yang sebenarnya.
    const ba = (await budgetOf(a))!.available;
    const bb = (await budgetOf(b))!.available;
    const ra = (await reserveBalances(db, { tokenMint: a }))[0]!.claimed;
    const rb = (await reserveBalances(db, { tokenMint: b }))[0]!.claimed;
    expect(ba + bb + ra + rb).toBe(36_000n);
    expect(ba + ra).toBe(27_000n);
  });
});

describe("EconomicEngine — kegagalan tanpa buyback/burn ganda", () => {
  async function funded(overrides: Partial<EconomicWorkerSettings> = {}) {
    const s = setup(overrides);
    const a = await seedToken();
    await trade(a, 50_000n);
    s.chain.curveVaults.set(SOL.mint, 50_000n);
    s.chain.slot = 9_000;
    await s.engine.runFeeProcessing();
    expect((await budgetOf(a))?.available).toBe(40_000n);
    return { ...s, a };
  }

  it("simulasi gagal (slippage di signer) → failed, budget utuh, retry setelah jeda, satu buyback", async () => {
    const { engine, signer, chain, clock, a } = await funded();
    signer.nextError = new SignerClientError(
      "simulation_failed",
      "simulasi gagal: ExceededSlippage",
      false,
    );
    const r1 = await engine.runBuyback();
    expect(r1.failed).toBe(1);
    expect(chain.executed.filter((t) => t.kind === "buyback")).toHaveLength(0);
    expect((await budgetOf(a))?.available).toBe(40_000n);
    // Masih dalam jeda retry: tidak dicoba lagi.
    expect((await engine.runBuyback()).created).toBe(0);
    clock.advance(SETTINGS.retryBackoffMs * 2); // updatedAt memakai jam DB (nyata)
    await engine.runBuyback();
    expect(chain.executed.filter((t) => t.kind === "buyback")).toHaveLength(1);
    expect(
      await db.economicOp.count({ where: { kind: "buyback", tokenMint: a, status: "confirmed" } }),
    ).toBe(1);
    expect(await db.burnLedger.count({ where: { tokenMint: a } })).toBe(1);
  });

  it("slippage terlampaui on-chain → transaksi gagal, tidak ada token & tidak ada burn", async () => {
    const { engine, chain, a } = await funded();
    chain.executionShortfallBps = 1_000n; // 10% < minOut (slippage 3%)
    const r = await engine.runBuyback();
    expect(r.failed).toBe(1);
    const op = await db.economicOp.findFirstOrThrow({ where: { kind: "buyback", tokenMint: a } });
    expect(op.status).toBe("failed");
    expect(op.lastError).toMatch(/gagal on-chain/);
    expect(await db.economicOp.count({ where: { kind: "burn", tokenMint: a } })).toBe(0);
    expect((await budgetOf(a))?.available).toBe(40_000n);
  });

  it("restart di tengah buyback (sesudah write-ahead, sebelum kirim) → transaksi yang sama dikirim ulang, sekali mendarat", async () => {
    const { chain, sender, make, a } = await funded();
    sender.crash = 2; // kirim awal + kirim ulang di siklus yang sama tidak pernah terjadi
    const first = make();
    await first.runBuyback();
    const op = await db.economicOp.findFirstOrThrow({ where: { kind: "buyback", tokenMint: a } });
    expect(op.status).toBe("signed");
    expect(op.signature).toBeTruthy();
    expect((await budgetOf(a))?.available).toBe(0n); // dana dicadangkan selama operasi aktif

    const restarted = make(); // proses baru
    await restarted.runBuyback();
    const after = await db.economicOp.findUniqueOrThrow({ where: { id: op.id } });
    expect(after.status).toBe("confirmed");
    expect(after.signature).toBe(op.signature);
    expect(chain.executed.filter((t) => t.kind === "buyback")).toHaveLength(1);
    expect(await db.economicOp.count({ where: { kind: "buyback", tokenMint: a } })).toBe(1);
    expect(await db.burnLedger.count({ where: { tokenMint: a } })).toBe(1);
  });

  it("transaksi menggantung lalu blockhash kedaluwarsa → expired, dana dilepas, buyback baru sekali", async () => {
    const { chain, sender, engine, clock, a } = await funded();
    sender.drop = 3; // kirim awal + kirim ulang (2 siklus) hilang
    await engine.runBuyback();
    const op = await db.economicOp.findFirstOrThrow({ where: { kind: "buyback", tokenMint: a } });
    expect(op.status).toBe("submitted");
    await engine.runBuyback(); // masih dalam masa berlaku: kirim ulang (hilang lagi)
    expect((await db.economicOp.findUniqueOrThrow({ where: { id: op.id } })).status).toBe(
      "submitted",
    );
    chain.height += 200; // lewat lastValidBlockHeight
    await engine.runBuyback();
    expect((await db.economicOp.findUniqueOrThrow({ where: { id: op.id } })).status).toBe(
      "expired",
    );
    expect(chain.executed.filter((t) => t.kind === "buyback")).toHaveLength(0);
    clock.advance(SETTINGS.retryBackoffMs * 2); // updatedAt memakai jam DB (nyata)
    await engine.runBuyback();
    expect(chain.executed.filter((t) => t.kind === "buyback")).toHaveLength(1);
    expect(await db.burnLedger.count({ where: { tokenMint: a } })).toBe(1);
  });

  it("signer dipause → operasi tertahan (pending), lanjut setelah resume tanpa duplikat", async () => {
    const { engine, signer, chain, vault } = setup();
    const a = await seedToken();
    await trade(a, 50_000n);
    chain.curveVaults.set(SOL.mint, 50_000n);
    chain.slot = 9_000;
    signer.paused = true;
    const r1 = await engine.runFeeProcessing();
    expect(r1.blocked).not.toBeNull();
    const claim = await db.economicOp.findFirstOrThrow({
      where: { kind: "claim_curve", target: vault },
    });
    expect(claim.status).toBe("pending");
    expect(chain.executed).toHaveLength(0);
    expect((await engine.runFeeProcessing()).created).toBe(0); // tidak membuat claim kedua
    signer.paused = false;
    await engine.runFeeProcessing();
    expect((await db.economicOp.findUniqueOrThrow({ where: { id: claim.id } })).status).toBe(
      "confirmed",
    );
    expect(chain.executed.filter((t) => t.kind === "claim_curve")).toHaveLength(1);
    signer.paused = true;
    expect((await engine.runBuyback()).blocked).not.toBeNull();
    expect(chain.executed.filter((t) => t.kind === "buyback")).toHaveLength(0);
  });

  it("double-run: dua proses bersamaan → satu buyback & satu burn", async () => {
    const { chain, make, a } = await funded();
    const [x, y] = [make(), make()];
    await Promise.all([x.runBuyback(), y.runBuyback()]);
    await Promise.all([x.runBuyback(), y.runBuyback()]);
    expect(chain.executed.filter((t) => t.kind === "buyback")).toHaveLength(1);
    expect(chain.executed.filter((t) => t.kind === "burn")).toHaveLength(1);
    expect(
      await db.economicOp.count({ where: { kind: "buyback", tokenMint: a, status: "confirmed" } }),
    ).toBe(1);
    expect(await db.burnLedger.count({ where: { tokenMint: a } })).toBe(1);
  });

  it("operasi confirmed bersifat final di DB", async () => {
    const { a } = await funded();
    const claim = await db.economicOp.findFirstOrThrow({
      where: { kind: "claim_curve", status: "confirmed" },
      orderBy: { createdAt: "desc" },
    });
    await expect(
      db.economicOp.update({ where: { id: claim.id }, data: { amountOut: 1 } }),
    ).rejects.toThrow(/final/);
    await expect(db.economicOp.delete({ where: { id: claim.id } })).rejects.toThrow();
    expect(a).toBeTruthy();
  });
});

describe("EconomicEngine — strategi fee intake `forwarded` (StonkFun)", () => {
  const FORWARDER = key();
  const forwarded = () => setup({ feeIntake: "forwarded", forwarders: [FORWARDER] });

  it("fee diteruskan forwarder dikenal → fee_forward confirmed → verified → 80/20 → buyback; ulang tanpa dobel", async () => {
    const { chain, engine, vault } = forwarded();
    const a = await seedToken("FWDA");
    const b = await seedToken("FWDB");
    await trade(a, 20_000n);
    await trade(b, 5_000n);
    chain.slot = 9_000;
    const s1 = sig();
    chain.forward(SOL.mint, 25_000n, { signature: s1, signers: [FORWARDER] });

    const res = await engine.runFeeProcessing();
    expect(res).toMatchObject({ failed: 0, blocked: null });
    const op = await db.economicOp.findUniqueOrThrow({ where: { signature: s1 } });
    expect(op).toMatchObject({ kind: "fee_forward", status: "confirmed", assetMint: SOL.mint });
    expect(op.amountOut?.toFixed(0)).toBe("25000");
    expect((op.details as { evidence?: string }).evidence).toBe("known_forwarder");
    const rec = await db.feeReconciliation.findFirstOrThrow({ where: { claimOpId: op.id } });
    expect(rec.status).toBe("verified");
    // Tidak ada claim on-chain: vault creator kosong (fee diteruskan otomatis).
    expect(await db.economicOp.count({ where: { kind: "claim_curve", target: vault } })).toBe(0);
    expect((await budgetOf(a))?.available).toBe(16_000n);
    expect((await budgetOf(b))?.available).toBe(4_000n);

    // Siklus berikutnya: kursor maju, signature sama tidak dicatat dua kali.
    await engine.runFeeProcessing();
    expect(await db.economicOp.count({ where: { signature: s1 } })).toBe(1);

    // Dana diteruskan dibelanjakan seperti dana claim.
    const bb = await engine.runBuyback();
    expect(bb.blocked).toBeNull();
    expect(
      await db.economicOp.count({ where: { kind: "buyback", tokenMint: a, status: "confirmed" } }),
    ).toBe(1);
  });

  it("selisih diteruskan vs ledger → estimated + correction; dana tak dikenal & transaksi master tidak dihitung", async () => {
    const { chain, engine, clock } = forwarded();
    const a = await seedToken("FWDE");
    await trade(a, 10_000n);
    chain.slot = 9_000;
    const ok = sig();
    const stranger = sig();
    const own = sig();
    // Diteruskan di dalam trade LaunchLab (tanpa forwarder dikenal) — jumlah di bawah ledger.
    chain.forward(SOL.mint, 9_000n, {
      signature: ok,
      signers: [key()],
      programs: [PLATFORM.launchlabProgram],
    });
    chain.forward(SOL.mint, 777n, { signature: stranger, signers: [key()] });
    chain.forward(SOL.mint, 555n, { signature: own, signers: [MASTER] });

    const res = await engine.runFeeProcessing();
    expect(res.skipped.some((s) => s.target === stranger)).toBe(true);
    expect(await db.economicOp.count({ where: { signature: { in: [stranger, own] } } })).toBe(0);
    clock.advance(SETTINGS.reconcileGraceMs + 1);
    await engine.runFeeProcessing();
    const op = await db.economicOp.findUniqueOrThrow({ where: { signature: ok } });
    expect((op.details as { evidence?: string }).evidence).toBe("launchlab_trade");
    const rec = await db.feeReconciliation.findFirstOrThrow({ where: { claimOpId: op.id } });
    expect(rec.status).toBe("estimated");
    expect(rec.differenceRaw.toFixed(0)).toBe("-1000");
    const budget = (await budgetOf(a))!.available;
    const reserve = (await reserveBalances(db, { tokenMint: a }))[0]!.claimed;
    expect(budget + reserve).toBe(9_000n);
  });

  it("fallback launch lama: vault creator yang masih berisi tetap di-claim di mode forwarded", async () => {
    const { chain, engine, vault } = forwarded();
    const a = await seedToken("FWDL");
    await trade(a, 12_000n);
    chain.curveVaults.set(SOL.mint, 12_000n);
    chain.slot = 9_000;
    await engine.runFeeProcessing();
    const claim = await db.economicOp.findFirstOrThrow({
      where: { kind: "claim_curve", target: vault },
    });
    expect(claim.status).toBe("confirmed");
    expect((await budgetOf(a))?.available).toBe(9_600n);
  });
});

describe("EconomicEngine — fee StonkFun sebagai SOL biasa", () => {
  const FORWARDER = key();
  const native = (o: Partial<EconomicWorkerSettings> = {}) =>
    setup({ feeIntake: "forwarded", forwarders: [FORWARDER], ...o });

  /** Trade mainnet: creator fee per trade 0, hanya volume yang tercatat. */
  async function tradeNoFee(mint: string, quote: bigint, s: number) {
    await recordTradeAndCreatorFee(
      db,
      {
        signature: sig(),
        route: "launchlab",
        side: "buy",
        mint,
        wallet: key(),
        amountIn: quote.toString(),
        amountOut: "1000000",
        fees: [],
        slot: s,
      },
      SOL.mint,
      { recordedBy: "indexer" },
    );
  }
  const reserveOf = async (mint: string) =>
    (await reserveBalances(db, { tokenMint: mint }))[0]?.claimed ?? 0n;

  it("dari forwarder → menunggu indexer → dibagi menurut volume, 80/20, estimated; ulang tanpa dobel", async () => {
    const { chain, engine, clock } = native();
    const a = await seedToken("NATA");
    const b = await seedToken("NATB");
    await tradeNoFee(a, 300_000n, 8_000);
    await tradeNoFee(b, 100_000n, 8_001);
    chain.slot = 9_000;
    const s1 = sig();
    chain.forwardNative(40_000n, { signature: s1, signers: [FORWARDER] });

    await engine.runFeeProcessing();
    expect(await budgetOf(a)).toBeUndefined(); // masih masa tunggu indexer
    clock.advance(SETTINGS.reconcileGraceMs + 1);
    await engine.runFeeProcessing();

    const op = await db.economicOp.findUniqueOrThrow({ where: { signature: s1 } });
    expect(op).toMatchObject({ kind: "fee_forward", status: "confirmed", assetMint: SOL.mint });
    const rec = await db.feeReconciliation.findFirstOrThrow({ where: { claimOpId: op.id } });
    expect(rec.status).toBe("estimated");
    expect(rec.ledgerRaw.toFixed(0)).toBe("0");
    expect(rec.unattributedRaw.toFixed(0)).toBe("0");
    expect((await budgetOf(a))?.available).toBe(24_000n);
    expect(await reserveOf(a)).toBe(6_000n);
    expect((await budgetOf(b))?.available).toBe(8_000n);
    expect(await reserveOf(b)).toBe(2_000n);

    await engine.runFeeProcessing();
    expect(await db.economicOp.count({ where: { signature: s1 } })).toBe(1);
    expect((await budgetOf(a))?.available).toBe(24_000n);

    // Kiriman berikutnya hanya memakai volume sejak kiriman sebelumnya.
    await tradeNoFee(b, 50_000n, 9_500);
    chain.slot = 10_000;
    chain.forwardNative(10_000n, { signature: sig(), signers: [FORWARDER] });
    await engine.runFeeProcessing();
    clock.advance(SETTINGS.reconcileGraceMs + 1);
    await engine.runFeeProcessing();
    expect((await budgetOf(a))?.available).toBe(24_000n);
    expect((await budgetOf(b))?.available).toBe(16_000n);
  });

  it("deposit, isi ulang, dan transaksi master tidak dihitung sebagai fee", async () => {
    const { chain, engine, clock } = native();
    const a = await seedToken("NATC");
    await tradeNoFee(a, 100_000n, 8_000);
    chain.slot = 9_000;
    const stranger = sig();
    const own = sig();
    chain.forwardNative(12_000_000n, { signature: stranger, signers: [key()] });
    chain.forwardNative(5_000n, { signature: own, signers: [MASTER, FORWARDER] });

    const res = await engine.runFeeProcessing();
    clock.advance(SETTINGS.reconcileGraceMs + 1);
    await engine.runFeeProcessing();
    expect(res.skipped.some((s) => s.target === stranger)).toBe(false);
    expect(await db.economicOp.count({ where: { signature: { in: [stranger, own] } } })).toBe(0);
    expect(await budgetOf(a)).toBeUndefined();
  });

  it("tanpa trade sama sekali → ditahan sebagai surplus, tidak dialokasikan ke token mana pun", async () => {
    const { chain, engine, clock } = native();
    await seedToken("NATD");
    chain.slot = 1; // sebelum semua trade
    const s1 = sig();
    chain.forwardNative(7_000n, { signature: s1, signers: [FORWARDER] });
    await engine.runFeeProcessing();
    clock.advance(SETTINGS.reconcileGraceMs + 1);
    await engine.runFeeProcessing();
    const op = await db.economicOp.findUniqueOrThrow({ where: { signature: s1 } });
    const rec = await db.feeReconciliation.findFirstOrThrow({ where: { claimOpId: op.id } });
    expect(rec.unattributedRaw.toFixed(0)).toBe("7000");
  });

  it("daftar forwarder kosong: kursor tidak maju, kiriman lama terbaca setelah alamat diisi", async () => {
    const { chain, engine, clock } = native({ forwarders: [] });
    const a = await seedToken("NATE");
    await tradeNoFee(a, 100_000n, 8_000);
    chain.slot = 9_000;
    const s1 = sig();
    chain.forwardNative(10_000n, { signature: s1, signers: [FORWARDER] });
    await engine.runFeeProcessing();
    expect(await db.economicOp.count({ where: { signature: s1 } })).toBe(0);

    const later = new EconomicEngine({
      db,
      chain,
      signer: new FakeEconomicSigner(),
      sender: new FakeSender(chain),
      cluster: "devnet",
      platform: PLATFORM,
      config: { ...SETTINGS, feeIntake: "forwarded", forwarders: [FORWARDER] },
      logger: silent,
      now: clock.now,
      sleep: async () => {},
    });
    await later.runFeeProcessing();
    expect(await db.economicOp.count({ where: { signature: s1 } })).toBe(1);
    clock.advance(SETTINGS.reconcileGraceMs + 1);
    await later.runFeeProcessing(); // selesaikan rekonsiliasi: economic_ops tidak dikosongkan antar test
  });

  it("transaksi belum tersedia di RPC: kursor berhenti, tidak ada kiriman yang terlewat", async () => {
    const { chain, engine, clock } = native();
    await seedToken("NATF");
    chain.slot = 9_000;
    const s1 = sig();
    const s2 = sig();
    chain.forwardNative(1_000n, { signature: s1, signers: [FORWARDER] });
    chain.forwardNative(2_000n, { signature: s2, signers: [FORWARDER] });
    chain.nativeUnavailable.add(s1);
    await engine.runFeeProcessing();
    expect(await db.economicOp.count({ where: { signature: { in: [s1, s2] } } })).toBe(0);
    chain.nativeUnavailable.clear();
    await engine.runFeeProcessing();
    expect(await db.economicOp.count({ where: { signature: { in: [s1, s2] } } })).toBe(2);
    clock.advance(SETTINGS.reconcileGraceMs + 1);
    await engine.runFeeProcessing();
  });

  it("FEE_SPENDING_ENABLED mati: fee tercatat, tidak ada buyback baru", async () => {
    const { chain, engine, clock } = native({ feeSpendingEnabled: false });
    const a = await seedToken("NATG");
    await tradeNoFee(a, 100_000n, 8_000);
    chain.slot = 9_000;
    chain.forwardNative(100_000n, { signature: sig(), signers: [FORWARDER] });
    await engine.runFeeProcessing();
    clock.advance(SETTINGS.reconcileGraceMs + 1);
    await engine.runFeeProcessing();
    expect((await budgetOf(a))?.available).toBe(80_000n);

    const res = await engine.runBuyback();
    expect(res.created).toBe(0);
    expect(await db.economicOp.count({ where: { kind: "buyback", tokenMint: a } })).toBe(0);
  });
});

describe("fundsSnapshot", () => {
  it("strategi forwarded: saldo SOL master ikut menutup dana fee pair SOL", async () => {
    const { chain, engine, clock } = setup({ feeIntake: "forwarded", forwarders: [MASTER] });
    const a = await seedToken("SNAP");
    await trade(a, 10_000n);
    chain.slot = 9_000;
    chain.forward(SOL.mint, 10_000n, {
      signature: sig(),
      signers: [key()],
      programs: [PLATFORM.launchlabProgram],
    });
    await engine.runFeeProcessing();
    clock.advance(SETTINGS.reconcileGraceMs + 1);
    await engine.runFeeProcessing();
    const ata = chain.ata(SOL.mint);
    const inAccount = await chain.tokenBalance(ata);
    const plain = await fundsSnapshot(db, chain);
    const withNative = await fundsSnapshot(db, chain, { nativeFeeFunds: true });
    expect(plain.balances[SOL.mint]).toBe(inAccount.toString());
    expect(withNative.balances[SOL.mint]).toBe((inAccount + chain.masterSol).toString());
  });
});
