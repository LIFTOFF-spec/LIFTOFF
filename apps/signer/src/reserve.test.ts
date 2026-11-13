/**
 * Signer untuk Conviction Reserve (Tahap 8): allowlist reserve_fund / reserve_deploy (transaksi asli
 * dari builder packages/solana/reserve) + validasi DB (graduation, 25% saldo kustodi, cooldown,
 * pause per token, token lain).
 */
import { randomUUID } from "node:crypto";
import { Prisma, type Db } from "@liftoff/db";
import { inspectTransaction, decodeTransaction } from "@liftoff/solana";
import {
  buildReserveDeployTx,
  buildReserveFundTx,
  reserveVaultAddresses,
} from "@liftoff/solana/reserve";
import { migratedCpmmPoolAddress, type Market } from "@liftoff/solana/trade";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import BN from "bn.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PolicyOp } from "./economic-policy";
import { checkReserveDeployPolicy, checkReserveFundPolicy } from "./reserve-policy";
import { checkDeployAgainstQuote, SignerService, type PoolQuote } from "./service";
import { BLOCKHASH, FakeSignerChain, resetDb, SOL_PAIR, testDb, testSetup } from "./test-helpers";
import { platformFor as platformOf } from "@liftoff/shared";

const CPMM_PROGRAM = platformOf("devnet").cpmmProgram;

const SOL = SOL_PAIR.mint;
const rnd = () => Keypair.generate().publicKey;
const connection = {
  getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1_000 }),
  getMinimumBalanceForRentExemption: async () => 2_039_280,
} as unknown as Connection;

type Platform = ReturnType<typeof testSetup>["platform"];
const env = (platform: Platform) => ({
  connection,
  platform,
  computeUnitLimit: 300_000,
  computeUnitPriceMicroLamports: 0,
});

/** Market CPMM sintetis (akun acak) untuk pool `poolId` token `mint`. */
function fakeMarket(poolId: string, mint: string, lpMint: PublicKey) {
  const quoteIsA =
    Buffer.compare(new PublicKey(SOL).toBuffer(), new PublicKey(mint).toBuffer()) < 0;
  const [a, b] = quoteIsA ? [SOL, mint] : [mint, SOL];
  return {
    route: "cpmm",
    poolId,
    pool: {
      configId: rnd(),
      vaultA: rnd(),
      vaultB: rnd(),
      mintA: new PublicKey(a),
      mintB: new PublicKey(b),
      mintLp: lpMint,
      mintProgramA: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      mintProgramB: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      observationId: rnd(),
      lpAmount: new BN(1_000_000),
    },
    programs: {
      token: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      quote: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    },
  } as unknown as Extract<Market, { route: "cpmm" }>;
}

const PLAN = {
  swapIn: 10_000n,
  swapMinOut: 9_000_000n,
  lpAmount: 500n,
  maxQuote: 10_000n,
  maxToken: 9_000_000n,
};

async function deployTx(
  platform: Platform,
  mint: string,
  pool: string,
  lpMint: PublicKey,
  opts: { vaultOf?: string; plan?: typeof PLAN; dropBurn?: boolean } = {},
) {
  const built = await buildReserveDeployTx(env(platform), {
    tokenMint: opts.vaultOf ?? mint,
    quoteMint: SOL,
    market: fakeMarket(pool, mint, lpMint),
    plan: opts.plan ?? PLAN,
    createTokenAccount: true,
    closeLpAccount: true,
  });
  if (!opts.dropBurn) return built.transaction;
  const tx = decodeTransaction(built.transaction);
  // Hapus instruksi burn + close (dua terakhir) untuk uji "LP tidak dibakar".
  tx.message.compiledInstructions.splice(-2, 2);
  return Buffer.from(tx.serialize()).toString("base64");
}

/**
 * State pool CPMM yang cocok dengan PLAN: swap 10.000 → ±9,1 juta token (minOut 9 juta di atas
 * batas 300 bps signer), LP 500 ≥ LP yang dijamin batas deposit (±436).
 */
const poolQuote = (pool: string): PoolQuote => ({
  route: "cpmm",
  pool,
  amountIn: PLAN.swapIn,
  expectedOut: 9_100_000n,
  cpmm: { reserveToken: 10_000_000_000n, reserveQuote: 10_000_000n, lpSupply: 500_000n },
});

const deployOp = (mint: string, amountIn = 20_000n, minOut = PLAN.swapMinOut): PolicyOp => ({
  kind: "reserve_deploy",
  tokenMint: mint,
  assetMint: SOL,
  target: mint,
  amountIn,
  minOut,
});

describe("allowlist reserve (fungsi murni)", () => {
  const { master, platform } = testSetup();
  const m = master.publicKey.toBase58();
  const tokenA = rnd().toBase58();
  const tokenB = rnd().toBase58();

  it("reserve_fund: hanya transfer persis ke kustodi token itu", async () => {
    const tx = (
      await buildReserveFundTx(env(platform), {
        tokenMint: tokenA,
        quoteMint: SOL,
        amount: 5_000n,
        createAccount: true,
      })
    ).transaction;
    const inspected = inspectTransaction(decodeTransaction(tx), []);
    const op: PolicyOp = {
      kind: "reserve_fund",
      tokenMint: tokenA,
      assetMint: SOL,
      target: reserveVaultAddresses(m, tokenA).quoteAccount,
      amountIn: 5_000n,
      minOut: null,
    };
    expect(checkReserveFundPolicy({ tx: inspected, master: m, op })).toEqual([]);
    // Jumlah berbeda, atau operasi milik token B memakai transaksi ke kustodi token A.
    expect(
      checkReserveFundPolicy({ tx: inspected, master: m, op: { ...op, amountIn: 4_999n } }),
    ).not.toEqual([]);
    const opB = { ...op, tokenMint: tokenB, target: reserveVaultAddresses(m, tokenB).quoteAccount };
    const v = checkReserveFundPolicy({ tx: inspected, master: m, op: opB });
    expect(v.join(" ")).toMatch(/kustodi/);
  });

  it("reserve_deploy: swap + deposit ke pool token itu + burn LP penuh", async () => {
    const pool = rnd().toBase58();
    const lp = rnd();
    const tx = await deployTx(platform, tokenA, pool, lp);
    const inspected = inspectTransaction(decodeTransaction(tx), []);
    const base = {
      tx: inspected,
      master: m,
      cpmmProgram: CPMM_PROGRAM,
      plan: PLAN,
      cpmmPool: pool,
      lpMint: lp.toBase58(),
    };
    expect(checkReserveDeployPolicy({ ...base, op: deployOp(tokenA) })).toEqual([]);
    // Pool token lain → ditolak.
    expect(
      checkReserveDeployPolicy({ ...base, op: deployOp(tokenA), cpmmPool: rnd().toBase58() }),
    ).not.toEqual([]);
    // Rencana LP berbeda dari instruksi → ditolak.
    expect(
      checkReserveDeployPolicy({
        ...base,
        op: deployOp(tokenA),
        plan: { ...PLAN, lpAmount: 501n },
      }),
    ).not.toEqual([]);
    // Batas operasi lebih kecil dari swap + deposit → ditolak.
    expect(checkReserveDeployPolicy({ ...base, op: deployOp(tokenA, 19_999n) }).join(" ")).toMatch(
      /melebihi batas/,
    );
  });

  it("reserve_deploy: memakai kustodi token A untuk operasi token B ditolak", async () => {
    const pool = rnd().toBase58();
    const lp = rnd();
    const tx = await deployTx(platform, tokenB, pool, lp, { vaultOf: tokenA });
    const v = checkReserveDeployPolicy({
      tx: inspectTransaction(decodeTransaction(tx), []),
      master: m,
      cpmmProgram: CPMM_PROGRAM,
      op: deployOp(tokenB),
      plan: PLAN,
      cpmmPool: pool,
      lpMint: lp.toBase58(),
    });
    expect(v.join(" ")).toMatch(/akun input|akun output|kustodi/);
  });

  it("reserve_deploy tanpa burn LP ditolak (Requirement 6)", async () => {
    const pool = rnd().toBase58();
    const lp = rnd();
    const tx = await deployTx(platform, tokenA, pool, lp, { dropBurn: true });
    const v = checkReserveDeployPolicy({
      tx: inspectTransaction(decodeTransaction(tx), []),
      master: m,
      cpmmProgram: CPMM_PROGRAM,
      op: deployOp(tokenA),
      plan: PLAN,
      cpmmPool: pool,
      lpMint: lp.toBase58(),
    });
    expect(v.join(" ")).toMatch(/dibakar/);
  });
});

describe("SignerService — reserve_deploy (validasi DB)", () => {
  let db: Db;
  beforeAll(async () => {
    db = await testDb();
  });
  beforeEach(async () => {
    await resetDb(db);
    await db.$executeRawUnsafe(
      `UPDATE "economic_ops" SET "status" = 'failed' WHERE "status" IN ('pending', 'signed', 'submitted')`,
    );
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  async function seed(opts: { graduated?: boolean } = {}) {
    const { master, config, platform } = testSetup();
    const chain = new FakeSignerChain();
    chain.spend = 0n;
    const service = new SignerService({ db, chain, master, config });
    const mint = rnd().toBase58();
    const user = await db.user.create({ data: { wallet: rnd().toBase58() } });
    await db.token.create({
      data: {
        name: "Reserve",
        ticker: "RSV",
        tickerNormalized: `rsv${randomUUID().slice(0, 6)}`,
        mint,
        quoteMint: SOL,
        quoteConfigId: SOL_PAIR.configId,
        creatorUserId: user.id,
        launchStatus: "live",
        graduatedAt: new Date(Date.now() - 2 * 86_400_000),
      },
    });
    const pool = migratedCpmmPoolAddress(CPMM_PROGRAM, chain.cpConfigId, mint, SOL);
    chain.quote = poolQuote(pool);
    const lp = rnd();
    await db.tokenGraduation.create({
      data: {
        tokenMint: mint,
        state: opts.graduated === false ? "pool_pending" : "verified",
        launchPool: rnd().toBase58(),
        cpmmPool: pool,
        lpMint: lp.toBase58(),
        addLiquiditySupported: true,
        reserveMonitoringActive: opts.graduated !== false,
        checkedAt: new Date(),
      },
    });
    // 100.000 lamport reserve sudah ada di kustodi token ini.
    await db.economicOp.create({
      data: {
        kind: "reserve_fund",
        status: "confirmed",
        idempotencyKey: `reserve_fund:${mint}:${randomUUID()}`,
        tokenMint: mint,
        assetMint: SOL,
        target: reserveVaultAddresses(platform.masterWallet, mint).quoteAccount,
        amountIn: new Prisma.Decimal(100_000),
        amountOut: new Prisma.Decimal(100_000),
        confirmedAt: new Date(),
      },
    });
    const op = (amountIn: bigint) =>
      db.economicOp.create({
        data: {
          kind: "reserve_deploy",
          idempotencyKey: `reserve_deploy:${mint}:${randomUUID()}`,
          tokenMint: mint,
          assetMint: SOL,
          target: mint,
          amountIn: new Prisma.Decimal(amountIn.toString()),
          minOut: new Prisma.Decimal(PLAN.swapMinOut.toString()),
          details: Object.fromEntries(Object.entries(PLAN).map(([k, v]) => [k, v.toString()])),
        },
      });
    const tx = await deployTx(platform, mint, pool, lp);
    return { service, mint, op, tx, chain, pool };
  }

  it("deploy ≤ 25% saldo kustodi token graduated → ditandatangani; > 25% ditolak", async () => {
    const s = await seed();
    const ok = await s.op(25_000n);
    const res = await s.service.sign(
      { purpose: "reserve_deploy", opId: ok.id, transaction: s.tx },
      null,
    );
    expect(res.signature).toBeTruthy();
    await db.economicOp.update({ where: { id: ok.id }, data: { status: "failed" } });
    const tooMuch = await s.op(25_001n);
    await expect(
      s.service.sign({ purpose: "reserve_deploy", opId: tooMuch.id, transaction: s.tx }, null),
    ).rejects.toMatchObject({ code: "policy_violation" });
  });

  it("cooldown 24 jam ditegakkan signer (worker ganda / bug worker)", async () => {
    const s = await seed();
    const first = await s.op(20_000n);
    await db.economicOp.update({
      where: { id: first.id },
      data: { status: "confirmed", confirmedAt: new Date(), amountOut: new Prisma.Decimal(19_000) },
    });
    const second = await s.op(20_000n);
    await expect(
      s.service.sign({ purpose: "reserve_deploy", opId: second.id, transaction: s.tx }, null),
    ).rejects.toThrow(/cooldown/);
  });

  it("token belum graduate / pool belum terverifikasi → ditolak (Rule 7)", async () => {
    const s = await seed({ graduated: false });
    const op = await s.op(10_000n);
    await expect(
      s.service.sign({ purpose: "reserve_deploy", opId: op.id, transaction: s.tx }, null),
    ).rejects.toThrow(/graduate/);
  });

  it("reserve token dipause → ditolak sebagai paused", async () => {
    const s = await seed();
    await db.reserveConfigOverride.create({
      data: { tokenMint: s.mint, paused: true, updatedBy: "test" },
    });
    const op = await s.op(10_000n);
    await expect(
      s.service.sign({ purpose: "reserve_deploy", opId: op.id, transaction: s.tx }, null),
    ).rejects.toMatchObject({ code: "paused" });
  });

  it("F2: swapMinOut lebih longgar dari quote signer sendiri → ditolak (sandwich)", async () => {
    const s = await seed();
    // Pool on-chain kini memberi 10 juta token: minOut 9 juta < 10 juta × (1 − 300 bps).
    s.chain.quote = { ...poolQuote(s.pool), expectedOut: 10_000_000n };
    const op = await s.op(20_000n);
    await expect(
      s.service.sign({ purpose: "reserve_deploy", opId: op.id, transaction: s.tx }, null),
    ).rejects.toMatchObject({
      code: "policy_violation",
      message: expect.stringMatching(/swapMinOut .* di bawah quote signer/),
    });
    expect(await db.signerSpend.count()).toBe(0);
  });
});

describe("checkDeployAgainstQuote (F2, fungsi murni)", () => {
  const q = poolQuote("pool");
  it("rencana worker yang wajar lolos", () => {
    expect(checkDeployAgainstQuote(PLAN, q, 300)).toEqual([]);
  });
  it("maxToken melebihi minOut swap (memakai token kustodi lain) → ditolak", () => {
    const v = checkDeployAgainstQuote({ ...PLAN, maxToken: PLAN.swapMinOut + 1n }, q, 300);
    expect(v.join()).toMatch(/maxToken/);
  });
  it("LP terlalu kecil untuk batas deposit (rasio pool bisa dimanipulasi) → ditolak", () => {
    const v = checkDeployAgainstQuote({ ...PLAN, lpAmount: 100n }, q, 300);
    expect(v.join()).toMatch(/LP 100 terlalu kecil/);
  });
  it("bukan pool CPMM → ditolak", () => {
    expect(checkDeployAgainstQuote(PLAN, { ...q, route: "launchlab", cpmm: null }, 300)).toEqual([
      "deployment reserve butuh pool CPMM",
    ]);
  });
});
