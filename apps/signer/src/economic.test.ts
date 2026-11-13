/**
 * Signer untuk economic engine (Tahap 7): allowlist claim / buyback / burn (instruksi asli dari
 * builder SDK Raydium) + validasi DB (status operasi, budget ledger, buyback induk burn).
 */
import { randomUUID } from "node:crypto";
import { recordTradeAndCreatorFee, type Db } from "@liftoff/db";
import { SIGNER_POLICY } from "@liftoff/shared";
import {
  buyExactInInstruction,
  claimCreatorFee,
  getPdaCreatorFeeVaultAuth,
  getPdaLaunchpadAuth,
  getPdaPlatformVault,
  makeSwapCpmmBaseInInstruction,
} from "@raydium-io/raydium-sdk-v2";
import { inspectTransaction } from "@liftoff/solana";
import { launchPoolAddress } from "@liftoff/solana/launchlab";
import { creatorFeeVault } from "@liftoff/solana/stonkfun";
import {
  associatedTokenAddress,
  closeAccountIx,
  createAtaIdempotentIx,
  migratedCpmmPoolAddress,
  TOKEN_PROGRAM,
} from "@liftoff/solana/trade";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  checkBurnPolicy,
  checkBuybackPolicy,
  checkFeeClaimPolicy,
  type PolicyOp,
} from "./economic-policy";
import { assetOutflow, SignerService } from "./service";
import {
  b64,
  BLOCKHASH,
  FakeSignerChain,
  resetDb,
  SOL_PAIR,
  testDb,
  testSetup,
} from "./test-helpers";
import { platformFor as platformOf } from "@liftoff/shared";

const CPMM_PROGRAM = platformOf("devnet").cpmmProgram;

const SOL = SOL_PAIR.mint;
const pk = (s: string) => new PublicKey(s);

function compile(payer: PublicKey, ixs: TransactionInstruction[]) {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: BLOCKHASH,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ...ixs],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

function claimCurveTx(
  master: PublicKey,
  platform: ReturnType<typeof testSetup>["platform"],
  recipient?: string,
) {
  const program = pk(platform.launchlabProgram);
  const m = master.toBase58();
  const ata = associatedTokenAddress(m, SOL);
  return compile(master, [
    createAtaIdempotentIx(m, ata, m, SOL),
    claimCreatorFee(
      program,
      master,
      getPdaCreatorFeeVaultAuth(program).publicKey,
      pk(creatorFeeVault(platform, SOL)),
      pk(recipient ?? ata),
      pk(SOL),
      pk(TOKEN_PROGRAM),
    ),
  ]);
}

function curveBuyTx(
  master: PublicKey,
  platform: ReturnType<typeof testSetup>["platform"],
  mint: string,
  amount: bigint,
  minOut: bigint,
  opts: { share?: bigint; userToken?: string } = {},
) {
  const program = pk(platform.launchlabProgram);
  const m = master.toBase58();
  const userToken = opts.userToken ?? associatedTokenAddress(m, mint);
  return compile(master, [
    createAtaIdempotentIx(m, associatedTokenAddress(m, mint), m, mint),
    buyExactInInstruction(
      program,
      master,
      getPdaLaunchpadAuth(program).publicKey,
      pk(SOL_PAIR.configId),
      pk(platform.platformId),
      pk(launchPoolAddress(platform, mint, SOL)),
      pk(userToken),
      pk(associatedTokenAddress(m, SOL)),
      Keypair.generate().publicKey,
      Keypair.generate().publicKey,
      pk(mint),
      pk(SOL),
      pk(TOKEN_PROGRAM),
      pk(TOKEN_PROGRAM),
      getPdaPlatformVault(program, pk(platform.platformId), pk(SOL)).publicKey,
      pk(creatorFeeVault(platform, SOL)),
      new BN(amount.toString()),
      new BN(minOut.toString()),
      new BN((opts.share ?? 0n).toString()),
      undefined,
    ),
  ]);
}

function burnTx(master: PublicKey, mint: string, amount: bigint, close = false, owner?: PublicKey) {
  const m = master.toBase58();
  const ata = associatedTokenAddress(m, mint);
  const data = Buffer.alloc(9);
  data[0] = 8;
  data.writeBigUInt64LE(amount, 1);
  const ixs = [
    new TransactionInstruction({
      programId: pk(TOKEN_PROGRAM),
      keys: [
        { pubkey: pk(ata), isSigner: false, isWritable: true },
        { pubkey: pk(mint), isSigner: false, isWritable: true },
        { pubkey: owner ?? master, isSigner: true, isWritable: false },
      ],
      data,
    }),
  ];
  if (close) ixs.push(closeAccountIx(ata, m, m));
  return compile(master, ixs);
}

describe("economic policy (fungsi murni)", () => {
  const { master, platform } = testSetup();
  const m = master.publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();

  it("claim vault curve: hanya ke ATA quote master", () => {
    const op: PolicyOp = {
      kind: "claim_curve",
      tokenMint: null,
      assetMint: SOL,
      target: creatorFeeVault(platform, SOL),
      amountIn: null,
      minOut: null,
    };
    const ok = inspectTransaction(claimCurveTx(master.publicKey, platform));
    expect(checkFeeClaimPolicy({ tx: ok, platform, cpmmProgram: CPMM_PROGRAM, op })).toEqual([]);
    const thief = Keypair.generate().publicKey.toBase58();
    const bad = inspectTransaction(
      claimCurveTx(master.publicKey, platform, associatedTokenAddress(thief, SOL)),
    );
    expect(
      checkFeeClaimPolicy({ tx: bad, platform, cpmmProgram: CPMM_PROGRAM, op }).join(),
    ).toMatch(/recipient/);
    // Transfer SOL ke pihak lain tidak pernah diizinkan di transaksi claim.
    const extra = compile(master.publicKey, [
      SystemProgram.transfer({ fromPubkey: master.publicKey, toPubkey: pk(thief), lamports: 1 }),
    ]);
    expect(
      checkFeeClaimPolicy({
        tx: inspectTransaction(extra),
        platform,
        cpmmProgram: CPMM_PROGRAM,
        op,
      }).length,
    ).toBeGreaterThan(0);
  });

  it("buyback curve: pool resmi, nominal & minOut persis operasi, tanpa referral", () => {
    const op: PolicyOp = {
      kind: "buyback",
      tokenMint: mint,
      assetMint: SOL,
      target: mint,
      amountIn: 16_000n,
      minOut: 15_000_000n,
    };
    const pools = { launchPool: launchPoolAddress(platform, mint, SOL), cpmmPool: null };
    const check = (tx: VersionedTransaction) =>
      checkBuybackPolicy({
        tx: inspectTransaction(tx),
        platform,
        cpmmProgram: CPMM_PROGRAM,
        op,
        ...pools,
      });
    expect(check(curveBuyTx(master.publicKey, platform, mint, 16_000n, 15_000_000n))).toEqual([]);
    expect(
      check(curveBuyTx(master.publicKey, platform, mint, 17_000n, 15_000_000n)).join(),
    ).toMatch(/amountIn/);
    expect(check(curveBuyTx(master.publicKey, platform, mint, 16_000n, 1n)).join()).toMatch(
      /minOut/,
    );
    expect(
      check(
        curveBuyTx(master.publicKey, platform, mint, 16_000n, 15_000_000n, { share: 1_000n }),
      ).join(),
    ).toMatch(/share/);
    const other = associatedTokenAddress(Keypair.generate().publicKey.toBase58(), mint);
    expect(
      check(
        curveBuyTx(master.publicKey, platform, mint, 16_000n, 15_000_000n, { userToken: other }),
      ).join(),
    ).toMatch(/akun token/);
    expect(
      checkBuybackPolicy({
        tx: inspectTransaction(curveBuyTx(master.publicKey, platform, mint, 16_000n, 15_000_000n)),
        platform,
        cpmmProgram: CPMM_PROGRAM,
        op: { ...op, minOut: 0n },
        ...pools,
      }).join(),
    ).toMatch(/slippage/);
  });

  it("buyback CPMM: hanya pool hasil migrasi token", () => {
    const cpConfig = Keypair.generate().publicKey.toBase58();
    const pool = migratedCpmmPoolAddress(CPMM_PROGRAM, cpConfig, mint, SOL);
    const op: PolicyOp = {
      kind: "buyback",
      tokenMint: mint,
      assetMint: SOL,
      target: mint,
      amountIn: 100n,
      minOut: 90n,
    };
    const swap = (p: string) =>
      compile(master.publicKey, [
        makeSwapCpmmBaseInInstruction(
          pk(CPMM_PROGRAM),
          master.publicKey,
          Keypair.generate().publicKey,
          pk(cpConfig),
          pk(p),
          pk(associatedTokenAddress(m, SOL)),
          pk(associatedTokenAddress(m, mint)),
          Keypair.generate().publicKey,
          Keypair.generate().publicKey,
          pk(TOKEN_PROGRAM),
          pk(TOKEN_PROGRAM),
          pk(SOL),
          pk(mint),
          Keypair.generate().publicKey,
          new BN(100),
          new BN(90),
        ),
      ]);
    const pools = { launchPool: launchPoolAddress(platform, mint, SOL), cpmmPool: pool };
    expect(
      checkBuybackPolicy({
        tx: inspectTransaction(swap(pool)),
        platform,
        cpmmProgram: CPMM_PROGRAM,
        op,
        ...pools,
      }),
    ).toEqual([]);
    const fake = Keypair.generate().publicKey.toBase58();
    expect(
      checkBuybackPolicy({
        tx: inspectTransaction(swap(fake)),
        platform,
        cpmmProgram: CPMM_PROGRAM,
        op,
        ...pools,
      }).join(),
    ).toMatch(/pool/);
  });

  it("burn: jumlah persis dari ATA token master; close hanya ke master", () => {
    const op: PolicyOp = {
      kind: "burn",
      tokenMint: mint,
      assetMint: mint,
      target: associatedTokenAddress(m, mint),
      amountIn: 500n,
      minOut: null,
    };
    expect(
      checkBurnPolicy({
        tx: inspectTransaction(burnTx(master.publicKey, mint, 500n, true)),
        master: m,
        op,
      }),
    ).toEqual([]);
    expect(
      checkBurnPolicy({
        tx: inspectTransaction(burnTx(master.publicKey, mint, 499n)),
        master: m,
        op,
      }).join(),
    ).toMatch(/jumlah burn/);
  });
});

describe("SignerService — tujuan ekonomi", () => {
  let db: Db;
  beforeAll(async () => {
    db = await testDb();
  });
  beforeEach(async () => {
    await resetDb(db);
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  async function setup(policy: Partial<typeof SIGNER_POLICY> = {}) {
    const { master, config, platform } = testSetup({
      policy: {
        ...SIGNER_POLICY,
        maxLamportsPerTx: 30_000_000,
        maxLamportsPer24h: 5_000_000_000,
        maxTxPer24h: 400,
        maxLamportsPerEconomicTx: 3_000_000,
        ...policy,
      },
    });
    const chain = new FakeSignerChain();
    chain.spend = 2_039_280n; // rent ATA token
    const service = new SignerService({ db, chain, master, config });
    const mint = Keypair.generate().publicKey.toBase58();
    const user = await db.user.create({
      data: { wallet: Keypair.generate().publicKey.toBase58() },
    });
    await db.token.create({
      data: {
        name: "E",
        ticker: "E",
        tickerNormalized: `e${randomUUID().slice(0, 6)}`,
        mint,
        quoteMint: SOL,
        quoteConfigId: SOL_PAIR.configId,
        creatorUserId: user.id,
        launchStatus: "live",
      },
    });
    return { master, platform, chain, service, mint };
  }

  /** Budget buyback 16.000 yang sudah di-claim: trade (ledger) + claim confirmed + tautan. */
  async function fund(mint: string) {
    const signature = `sig-${randomUUID()}`;
    await recordTradeAndCreatorFee(
      db,
      {
        signature,
        route: "launchlab",
        side: "buy",
        mint,
        wallet: "w",
        amountIn: "4000000",
        amountOut: "1",
        slot: 1,
        fees: [
          { kind: "creator", label: "c", rate: 5000, amount: "20000", mint: SOL, recipient: "m" },
        ],
      },
      SOL,
    );
    const claim = await db.economicOp.create({
      data: {
        kind: "claim_curve",
        status: "confirmed",
        target: `vault-${randomUUID()}`,
        assetMint: SOL,
        idempotencyKey: randomUUID(),
        signature: `claim-${randomUUID()}`,
      },
    });
    const received = await db.feeLedger.findFirstOrThrow({
      where: { sourceSignature: signature, entryType: "received" },
    });
    await db.feeClaimItem.create({ data: { feeLedgerId: received.id, claimOpId: claim.id } });
  }

  const buybackOp = (mint: string, amountIn: number) =>
    db.economicOp.create({
      data: {
        kind: "buyback",
        target: mint,
        tokenMint: mint,
        assetMint: SOL,
        idempotencyKey: randomUUID(),
        amountIn,
        minOut: 1_000,
      },
    });

  it("buyback dalam budget ditandatangani; di atas budget ditolak (budget dihitung signer dari ledger)", async () => {
    const { master, platform, service, mint } = await setup();
    await fund(mint);
    const over = await buybackOp(mint, 16_001);
    await expect(
      service.sign(
        {
          purpose: "buyback",
          opId: over.id,
          transaction: b64(curveBuyTx(master.publicKey, platform, mint, 16_001n, 1_000n)),
        },
        null,
      ),
    ).rejects.toMatchObject({ code: "policy_violation", message: expect.stringMatching(/budget/) });
    await db.economicOp.update({ where: { id: over.id }, data: { status: "failed" } });

    const ok = await buybackOp(mint, 16_000);
    const res = await service.sign(
      {
        purpose: "buyback",
        opId: ok.id,
        transaction: b64(curveBuyTx(master.publicKey, platform, mint, 16_000n, 1_000n)),
      },
      null,
    );
    expect(res.signature).toBeTruthy();
    const spend = await db.signerSpend.findUniqueOrThrow({ where: { signature: res.signature } });
    expect(spend.purpose).toBe("buyback");
    const audit = await db.auditEvent.findFirstOrThrow({ where: { txSignature: res.signature } });
    expect(audit.details).toMatchObject({ opId: ok.id, purpose: "buyback" });
  });

  it("operasi bukan pending / tujuan tidak cocok / signer dipause → ditolak", async () => {
    const { master, platform, service, mint } = await setup();
    await fund(mint);
    const op = await buybackOp(mint, 1_000);
    const tx = b64(curveBuyTx(master.publicKey, platform, mint, 1_000n, 1_000n));
    await expect(
      service.sign({ purpose: "burn", opId: op.id, transaction: tx }, null),
    ).rejects.toMatchObject({ code: "policy_violation" });
    await service.setPaused(true, "test", "uji pause", null);
    await expect(
      service.sign({ purpose: "buyback", opId: op.id, transaction: tx }, null),
    ).rejects.toMatchObject({ code: "paused" });
    await service.setPaused(false, "test", "uji resume", null);
    await db.economicOp.update({ where: { id: op.id }, data: { status: "failed" } });
    await expect(
      service.sign({ purpose: "buyback", opId: op.id, transaction: tx }, null),
    ).rejects.toMatchObject({ code: "policy_violation" });
  });

  it("simulasi gagal (mis. slippage) → simulation_failed, tidak ada spend tercatat", async () => {
    const { master, platform, chain, service, mint } = await setup();
    await fund(mint);
    const op = await buybackOp(mint, 1_000);
    chain.simErr = { InstructionError: [2, { Custom: 6005 }] };
    await expect(
      service.sign(
        {
          purpose: "buyback",
          opId: op.id,
          transaction: b64(curveBuyTx(master.publicKey, platform, mint, 1_000n, 1_000n)),
        },
        null,
      ),
    ).rejects.toMatchObject({ code: "simulation_failed", retryable: false });
    expect(await db.signerSpend.count()).toBe(0);
  });

  it("burn hanya untuk jumlah persis hasil buyback confirmed", async () => {
    const { master, service, mint } = await setup();
    const m = master.publicKey.toBase58();
    const parent = await db.economicOp.create({
      data: {
        kind: "buyback",
        status: "confirmed",
        target: mint,
        tokenMint: mint,
        assetMint: SOL,
        idempotencyKey: randomUUID(),
        amountIn: 1_000,
        amountOut: 777,
        signature: `bb-${randomUUID()}`,
      },
    });
    const burn = await db.economicOp.create({
      data: {
        kind: "burn",
        target: associatedTokenAddress(m, mint),
        tokenMint: mint,
        assetMint: mint,
        idempotencyKey: randomUUID(),
        amountIn: 777,
        parentOpId: parent.id,
      },
    });
    await expect(
      service.sign(
        { purpose: "burn", opId: burn.id, transaction: b64(burnTx(master.publicKey, mint, 700n)) },
        null,
      ),
    ).rejects.toMatchObject({ code: "policy_violation" });
    const res = await service.sign(
      {
        purpose: "burn",
        opId: burn.id,
        transaction: b64(burnTx(master.publicKey, mint, 777n, true)),
      },
      null,
    );
    expect(res.signature).toBeTruthy();
  });

  it("claim CPMM hanya untuk pool hasil migrasi token itu", async () => {
    const { master, chain, service, mint } = await setup();
    const pool = migratedCpmmPoolAddress(CPMM_PROGRAM, chain.cpConfigId, mint, SOL);
    const wrong = await db.economicOp.create({
      data: {
        kind: "claim_cpmm",
        target: Keypair.generate().publicKey.toBase58(),
        tokenMint: mint,
        assetMint: SOL,
        idempotencyKey: randomUUID(),
      },
    });
    await expect(
      service.sign(
        {
          purpose: "fee_claim",
          opId: wrong.id,
          transaction: b64(burnTx(master.publicKey, mint, 1n)),
        },
        null,
      ),
    ).rejects.toMatchObject({ code: "policy_violation", message: expect.stringMatching(/pool/) });
    expect(pool).toBeTruthy();
  });

  it("config on-chain berubah (cpConfigId Platform PDA) → claim ke pool lama ditolak", async () => {
    const { master, chain, service, mint } = await setup();
    const oldPool = migratedCpmmPoolAddress(CPMM_PROGRAM, chain.cpConfigId, mint, SOL);
    const op = await db.economicOp.create({
      data: {
        kind: "claim_cpmm",
        target: oldPool,
        tokenMint: mint,
        assetMint: SOL,
        idempotencyKey: randomUUID(),
      },
    });
    chain.cpConfigId = Keypair.generate().publicKey.toBase58();
    await expect(
      service.sign(
        { purpose: "fee_claim", opId: op.id, transaction: b64(burnTx(master.publicKey, mint, 1n)) },
        null,
      ),
    ).rejects.toMatchObject({ code: "policy_violation", message: expect.stringMatching(/pool/) });
    expect(await db.signerSpend.count()).toBe(0);
  });

  it("saldo master rendah (InsufficientFundsForFee) → retryable, tidak ditandatangani", async () => {
    const { master, platform, chain, service, mint } = await setup();
    await fund(mint);
    const op = await buybackOp(mint, 1_000);
    chain.simErr = "InsufficientFundsForFee";
    await expect(
      service.sign(
        {
          purpose: "buyback",
          opId: op.id,
          transaction: b64(curveBuyTx(master.publicKey, platform, mint, 1_000n, 1_000n)),
        },
        null,
      ),
    ).rejects.toMatchObject({ code: "simulation_failed", retryable: true });
    expect(await db.signerSpend.count()).toBe(0);
  });

  it("buyback yang sama tidak bisa ditandatangani dua kali selama transaksi pertama hidup", async () => {
    const { master, platform, chain, service, mint } = await setup();
    await fund(mint);
    const op = await buybackOp(mint, 1_000);
    const tx = curveBuyTx(master.publicKey, platform, mint, 1_000n, 1_000n);
    await service.sign({ purpose: "buyback", opId: op.id, transaction: b64(tx) }, null);
    chain.liveBlockhashes.add(tx.message.recentBlockhash);
    const again = curveBuyTx(master.publicKey, platform, mint, 1_000n, 1_000n);
    again.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
    await expect(
      service.sign({ purpose: "buyback", opId: op.id, transaction: b64(again) }, null),
    ).rejects.toMatchObject({ code: "policy_violation", retryable: true });
    expect(await db.signerSpend.count({ where: { opId: op.id } })).toBe(1);
  });

  it("request: purpose ekonomi wajib opId, launch wajib jobId", async () => {
    const { signerSignRequestSchema } = await import("@liftoff/shared");
    expect(
      signerSignRequestSchema.safeParse({
        purpose: "buyback",
        jobId: randomUUID(),
        transaction: "AA==",
      }).success,
    ).toBe(false);
    expect(
      signerSignRequestSchema.safeParse({
        purpose: "launch",
        opId: randomUUID(),
        transaction: "AA==",
      }).success,
    ).toBe(false);
    expect(
      signerSignRequestSchema.safeParse({
        purpose: "burn",
        opId: randomUUID(),
        transaction: "AA==",
      }).success,
    ).toBe(true);
  });

  const buy = (
    service: SignerService,
    master: Keypair,
    platform: ReturnType<typeof testSetup>["platform"],
    mint: string,
    opId: string,
    amount: bigint,
    minOut = 1_000n,
    scope: "all" | "launch" | "economic" = "all",
  ) =>
    service.sign(
      {
        purpose: "buyback",
        opId,
        transaction: b64(curveBuyTx(master.publicKey, platform, mint, amount, minOut)),
      },
      null,
      scope,
    );

  it("F2: minOut di bawah quote signer × (1 − batas slippage config) → ditolak", async () => {
    const { master, platform, chain, service, mint } = await setup();
    await fund(mint);
    // Pool on-chain memberi 2.000 token; batas 500 bps → minOut minimal 1.900. Worker minta 1.000.
    chain.quote = { ...chain.quote, expectedOut: 2_000n };
    const op = await buybackOp(mint, 16_000);
    await expect(buy(service, master, platform, mint, op.id, 16_000n)).rejects.toMatchObject({
      code: "policy_violation",
      message: expect.stringMatching(/minOut 1000 di bawah quote signer 2000/),
    });
    expect(await db.signerSpend.count()).toBe(0);
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { result: "rejected:policy_violation", details: { path: ["opId"], equals: op.id } },
    });
    expect(audit.details).toMatchObject({ purpose: "buyback", scope: "all" });

    // minOut tepat di batas lolos (quote 1.052 × 0,95 = 999 ≤ 1.000).
    chain.quote = { ...chain.quote, expectedOut: 1_052n };
    await db.economicOp.update({ where: { id: op.id }, data: { status: "failed" } });
    const ok = await buybackOp(mint, 16_000);
    await expect(buy(service, master, platform, mint, ok.id, 16_000n)).resolves.toBeTruthy();
    expect(chain.quotes).toBe(2);
  });

  it("F2: rute transaksi ≠ rute pool on-chain (curve vs CPMM) → ditolak", async () => {
    const { master, platform, chain, service, mint } = await setup();
    await fund(mint);
    chain.quote = { ...chain.quote, route: "cpmm" };
    const op = await buybackOp(mint, 1_000);
    await expect(buy(service, master, platform, mint, op.id, 1_000n)).rejects.toThrow(
      /rute transaksi launchlab ≠ rute pool on-chain cpmm/,
    );
  });

  it("F3: keluaran WSOL dari ATA master diukur simulasi & dibatasi per 24 jam", async () => {
    const { master, platform, chain, service, mint } = await setup({
      maxAssetOutflowRawPer24h: { [SOL]: "20000", default: "1" },
    });
    await fund(mint);
    await fund(mint);
    const wsolAta = associatedTokenAddress(master.publicKey.toBase58(), SOL);
    chain.tokenPre.set(wsolAta, 100_000n);
    chain.tokenPost.set(wsolAta, 84_000n);
    const first = await buybackOp(mint, 16_000);
    const res = await buy(service, master, platform, mint, first.id, 16_000n);
    const row = await db.signerSpend.findUniqueOrThrow({ where: { signature: res.signature } });
    expect(row.assets).toEqual({ [SOL]: "16000" });
    const audit = await db.auditEvent.findFirstOrThrow({ where: { txSignature: res.signature } });
    expect(audit.details).toMatchObject({ assetOutflow: { [SOL]: "16000" } });

    // Buyback kedua (budget ledger masih cukup) melampaui batas absolut 20.000 per 24 jam.
    await db.economicOp.update({ where: { id: first.id }, data: { status: "confirmed" } });
    const second = await buybackOp(mint, 16_000);
    await expect(buy(service, master, platform, mint, second.id, 16_000n)).rejects.toMatchObject({
      code: "limit_exceeded",
      message: expect.stringMatching(/batas aset 24 jam .*16000 \+ 16000 > 20000/),
    });
    expect(await db.signerSpend.count()).toBe(1);
  });

  it("F3: pemindahan internal ATA → kustodi bukan keluaran aset", () => {
    const watch = [
      { account: "ata", mint: SOL },
      { account: "custody", mint: SOL },
      { account: "tokenAta", mint: "T" },
    ];
    expect(assetOutflow(watch, [100n, 0n, 5n], [40n, 60n, 0n])).toEqual({ T: "5" });
  });

  it("F8: aksi besar dicek silang di RPC cadangan; saldo beda → ditolak (retryable)", async () => {
    const { master, platform, chain, service, mint } = await setup({
      crossCheckMinRaw: { [SOL]: "10000", default: "10000" },
    });
    await fund(mint);
    chain.spend = 0n; // SOL native: hanya fee 5.000 < threshold
    const wsolAta = associatedTokenAddress(master.publicKey.toBase58(), SOL);
    chain.tokenPre.set(wsolAta, 100_000n);

    // Keluaran 8.000 < threshold 10.000 → tidak dicek silang.
    chain.tokenPost.set(wsolAta, 92_000n);
    const small = await buybackOp(mint, 8_000);
    const a = await buy(service, master, platform, mint, small.id, 8_000n);
    expect(
      (await db.auditEvent.findFirstOrThrow({ where: { txSignature: a.signature } })).details,
    ).toMatchObject({ crossCheck: null });
    await db.economicOp.update({ where: { id: small.id }, data: { status: "failed" } });

    // Keluaran 10.000 tanpa RPC cadangan → dilewati, dicatat.
    chain.tokenPost.set(wsolAta, 90_000n);
    const noBackup = await buybackOp(mint, 10_000);
    const b = await buy(service, master, platform, mint, noBackup.id, 10_000n);
    expect(
      (await db.auditEvent.findFirstOrThrow({ where: { txSignature: b.signature } })).details,
    ).toMatchObject({ crossCheck: { status: "skipped" } });
    await db.economicOp.update({ where: { id: noBackup.id }, data: { status: "failed" } });

    // RPC cadangan melihat saldo ATA berbeda → ditolak, retryable, tidak ada spend baru.
    const backup = new FakeSignerChain();
    backup.balanceLamports = chain.balanceLamports;
    backup.quote = chain.quote;
    backup.tokenPre.set(wsolAta, 99_000n);
    chain.backup = backup;
    const big = await buybackOp(mint, 10_000);
    await expect(buy(service, master, platform, mint, big.id, 10_000n)).rejects.toMatchObject({
      code: "rpc_unavailable",
      retryable: true,
      message: expect.stringMatching(/cek silang RPC gagal/),
    });
    expect(await db.signerSpend.count({ where: { opId: big.id } })).toBe(0);

    // Quote pool berbeda > toleransi 100 bps → ditolak.
    backup.tokenPre.set(wsolAta, 100_000n);
    backup.quote = { ...chain.quote, expectedOut: 1_100n };
    await expect(buy(service, master, platform, mint, big.id, 10_000n)).rejects.toThrow(
      /cek silang RPC gagal: quote pool/,
    );

    // Saldo & quote cocok → ditandatangani; audit mencatat cek silang ok.
    backup.quote = chain.quote;
    const res = await buy(service, master, platform, mint, big.id, 10_000n);
    expect(
      (await db.auditEvent.findFirstOrThrow({ where: { txSignature: res.signature } })).details,
    ).toMatchObject({ crossCheck: { status: "ok" } });
  });

  it("F12: token cakupan launch tidak bisa meminta buyback; cakupan economic bisa", async () => {
    const { master, platform, service, mint } = await setup();
    await fund(mint);
    const op = await buybackOp(mint, 1_000);
    await expect(
      buy(service, master, platform, mint, op.id, 1_000n, 1_000n, "launch"),
    ).rejects.toMatchObject({ code: "unauthorized" });
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { result: "rejected:unauthorized", details: { path: ["opId"], equals: op.id } },
    });
    expect(audit.details).toMatchObject({ scope: "launch", purpose: "buyback" });
    await expect(
      buy(service, master, platform, mint, op.id, 1_000n, 1_000n, "economic"),
    ).resolves.toBeTruthy();
  });
});
