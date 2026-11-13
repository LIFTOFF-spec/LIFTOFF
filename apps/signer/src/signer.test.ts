import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "@liftoff/db";
import { SIGNER_POLICY } from "@liftoff/shared";
import { inspectTransaction } from "@liftoff/solana";
import { Keypair, PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildSignerApp } from "./app";
import { isInsideRepo, loadSignerConfig, REPO_ROOT } from "./config";

import { deriveMintKeypair, loadMasterKeypair } from "./keys";
import {
  associatedTokenAddress,
  createAtaIdempotentIx,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
} from "@liftoff/solana/token-program";
import { checkLaunchPolicy } from "./policy";
import { SignerService } from "./service";
import {
  b64,
  BLOCKHASH,
  FakeSignerChain,
  launchTx,
  refundTx,
  resetDb,
  seedJob,
  SOL_PAIR,
  testDb,
  testSetup,
} from "./test-helpers";
import { launchPoolAddress } from "@liftoff/solana/launchlab";

const JITO_TIP = "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5";
// audit_events append-only (tidak bisa dikosongkan antar run) → requestId unik per run.
const run = randomUUID().slice(0, 8);
const rid = (name: string) => `${name}-${run}`;

describe("signer di mainnet", () => {
  const master = Keypair.generate();
  const env = {
    SIGNER_KEYPAIR_PATH: join(tmpdir(), "m.json"),
    SIGNER_AUTH_TOKEN: "t".repeat(40),
    SOLANA_CLUSTER: "mainnet-beta",
    STONKFUN_MAINNET_ENABLED: "1",
    LIFTOFF_MAINNET_APPROVED: "ya",
    MASTER_WALLET_PUBKEY: master.publicKey.toBase58(),
    RPC_URL: "https://mainnet.example",
  } as NodeJS.ProcessEnv;
  const service = (key: Keypair) =>
    new SignerService({
      db: {} as never,
      chain: {} as never,
      master: key,
      config: loadSignerConfig(env),
    });

  it("config: semua syarat wajib; alamat program mainnet, bukan devnet", () => {
    const cfg = loadSignerConfig(env);
    expect(cfg.cluster).toBe("mainnet-beta");
    expect(cfg.platform.launchlabProgram).toBe("LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj");
    expect(cfg.platform.cpmmProgram).toBe("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
    for (const k of [
      "STONKFUN_MAINNET_ENABLED",
      "LIFTOFF_MAINNET_APPROVED",
      "MASTER_WALLET_PUBKEY",
    ]) {
      expect(() => loadSignerConfig({ ...env, [k]: "" })).toThrow(k);
    }
    expect(() => loadSignerConfig({ ...env, RPC_URL: "" })).toThrow(/RPC_URL wajib/);
  });

  it("keypair harus cocok dengan MASTER_WALLET_PUBKEY: selain itu signer gagal start", () => {
    expect(service(master)).toBeInstanceOf(SignerService);
    expect(() => service(Keypair.generate())).toThrow(/bukan master wallet.*mainnet-beta/);
  });

  it("pesan penolakan tidak memuat secret key", () => {
    const other = Keypair.generate();
    let pesan = "";
    try {
      service(other);
    } catch (err) {
      pesan = (err as Error).message;
    }
    expect(pesan).not.toContain(other.secretKey.join(","));
    expect(pesan).not.toContain(other.publicKey.toBase58());
  });
});

describe("config & keys", () => {
  it("menolak keypair di dalam repo dan token pendek", () => {
    const env = { SIGNER_AUTH_TOKEN: "x".repeat(40), SOLANA_CLUSTER: "devnet" };
    expect(existsSync(join(REPO_ROOT, "pnpm-workspace.yaml"))).toBe(true);
    expect(() =>
      loadSignerConfig({ ...env, SIGNER_KEYPAIR_PATH: join(REPO_ROOT, "keys", "m.json") }),
    ).toThrow(/di luar repo/);
    expect(() =>
      loadSignerConfig({ SIGNER_KEYPAIR_PATH: "/elsewhere/m.json", SIGNER_AUTH_TOKEN: "short" }),
    ).toThrow(/minimal 32/);
    expect(isInsideRepo(join(tmpdir(), "x.json"))).toBe(false);
    const ok = loadSignerConfig({ ...env, SIGNER_KEYPAIR_PATH: join(tmpdir(), "m.json") });
    expect(ok.host).toBe("127.0.0.1");
    expect(ok.authTokens).toEqual([{ token: "x".repeat(40), scope: "all" }]);
    expect(ok.backupRpcUrl).toBeNull();
    expect(ok.policy.maxBuybackSlippageBps).toBe(SIGNER_POLICY.maxBuybackSlippageBps);
  });

  it("F12: token per worker; token sama / kosong ditolak; F2/F3/F8 dari env", () => {
    const path = { SIGNER_KEYPAIR_PATH: join(tmpdir(), "m.json"), SOLANA_CLUSTER: "devnet" };
    const scoped = loadSignerConfig({
      ...path,
      SIGNER_LAUNCH_TOKEN: "a".repeat(32),
      SIGNER_ECONOMIC_TOKEN: "b".repeat(32),
      RPC_BACKUP_URL: "https://backup.devnet.invalid",
      SIGNER_MAX_BUYBACK_SLIPPAGE_BPS: "400",
      SIGNER_MAX_ASSET_OUTFLOW_PER_24H: "sol=5000",
    });
    expect(scoped.authTokens.map((t) => t.scope)).toEqual(["launch", "economic"]);
    expect(scoped.backupRpcUrl).toBe("https://backup.devnet.invalid");
    expect(scoped.policy.maxBuybackSlippageBps).toBe(400);
    expect(scoped.policy.maxAssetOutflowRawPer24h.So11111111111111111111111111111111111111112).toBe(
      "5000",
    );
    expect(() =>
      loadSignerConfig({
        ...path,
        SIGNER_LAUNCH_TOKEN: "a".repeat(32),
        SIGNER_ECONOMIC_TOKEN: "a".repeat(32),
      }),
    ).toThrow(/berbeda/);
    expect(() => loadSignerConfig(path)).toThrow(/token signer wajib/);
    expect(() =>
      loadSignerConfig({
        ...path,
        SIGNER_AUTH_TOKEN: "x".repeat(40),
        SIGNER_MAX_RESERVE_SLIPPAGE_BPS: "0",
      }),
    ).toThrow(/1..2000/);
  });

  it("mint keypair deterministik per job, berbeda antar job", () => {
    const master = Keypair.generate();
    const a = deriveMintKeypair(master, "0190f3d2-0000-7000-8000-000000000001");
    const b = deriveMintKeypair(master, "0190f3d2-0000-7000-8000-000000000001");
    const c = deriveMintKeypair(master, "0190f3d2-0000-7000-8000-000000000002");
    expect(a.publicKey.equals(b.publicKey)).toBe(true);
    expect(a.publicKey.equals(c.publicKey)).toBe(false);
    expect(
      deriveMintKeypair(
        Keypair.generate(),
        "0190f3d2-0000-7000-8000-000000000001",
      ).publicKey.equals(a.publicKey),
    ).toBe(false);
  });

  it("loadMasterKeypair tidak membocorkan isi file di pesan error", () => {
    const dir = mkdtempSync(join(tmpdir(), "liftoff-signer-"));
    const path = join(dir, "bad.json");
    writeFileSync(path, "[1,2,3,SECRET]");
    expect(() => loadMasterKeypair(path)).toThrow(/tidak bisa dibaca/);
    try {
      loadMasterKeypair(path);
    } catch (e) {
      expect((e as Error).message).not.toContain("SECRET");
    }
    const kp = Keypair.generate();
    writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
    expect(loadMasterKeypair(path).publicKey.equals(kp.publicKey)).toBe(true);
  });
});

describe("checkLaunchPolicy", () => {
  const { master, platform } = testSetup();
  const mint = Keypair.generate().publicKey;
  const pool = launchPoolAddress(platform, mint.toBase58(), SOL_PAIR.mint);
  const run = (tx: VersionedTransaction) =>
    checkLaunchPolicy({
      tx: inspectTransaction(tx),
      platform,
      mint: mint.toBase58(),
      pool,
      configId: SOL_PAIR.configId,
      maxTipLamports: 1_000_000,
    });
  const m = master.publicKey;

  it("transaksi launch yang benar lolos", () => {
    expect(run(launchTx({ master: m, mint }))).toEqual([]);
  });

  describe("ATA quote master pada launch non-SOL", () => {
    const quote = Keypair.generate().publicKey.toBase58();
    const masterKey = m.toBase58();
    const ata = associatedTokenAddress(masterKey, quote, TOKEN_2022_PROGRAM);
    const withAta = (tx: VersionedTransaction, a = ata) =>
      checkLaunchPolicy({
        tx: inspectTransaction(tx),
        platform,
        mint: mint.toBase58(),
        pool,
        configId: SOL_PAIR.configId,
        maxTipLamports: 1_000_000,
        quoteAta: { ata: a, mint: quote },
      });
    const create = (owner = masterKey, account = ata, payer = masterKey) =>
      createAtaIdempotentIx(payer, account, owner, quote, TOKEN_2022_PROGRAM);

    it("ATA yang tepat lolos; tanpa izin `quoteAta` ditolak", () => {
      const tx = launchTx({ master: m, mint, extra: [create()] });
      expect(withAta(tx)).toEqual([]);
      expect(run(tx).join("; ")).toMatch(/tidak diizinkan/);
    });

    it("ATA milik wallet lain atau akun lain ditolak", () => {
      const other = Keypair.generate().publicKey.toBase58();
      const otherAta = associatedTokenAddress(other, quote, TOKEN_2022_PROGRAM);
      for (const ix of [create(other, otherAta), create(masterKey, otherAta)]) {
        const v = withAta(launchTx({ master: m, mint, extra: [ix] }));
        expect(v.join("; ")).toMatch(/tidak diizinkan/);
      }
    });
  });

  it.each([
    ["platform lain", { platformId: Keypair.generate().publicKey.toBase58() }, /platform/],
    ["mint lain", { mint: Keypair.generate().publicKey }, /mint|signer/],
    ["pool lain", { pool: Keypair.generate().publicKey.toBase58() }, /pool/],
    ["config lain", { configId: Keypair.generate().publicKey.toBase58() }, /global config/],
    ["instruksi LaunchLab lain", { discriminator: "fafafafafafafafa" }, /initialize_v2/],
    ["fee payer lain", { payer: Keypair.generate().publicKey }, /fee payer|signer/],
  ])("ditolak: %s", (_name, opts, pattern) => {
    const v = run(launchTx({ master: m, mint, ...opts }));
    expect(v.length).toBeGreaterThan(0);
    expect(v.join("; ")).toMatch(pattern);
  });

  it("transfer SOL ke alamat di luar allowlist ditolak", () => {
    const thief = Keypair.generate().publicKey;
    const v = run(
      launchTx({
        master: m,
        mint,
        extra: [SystemProgram.transfer({ fromPubkey: m, toPubkey: thief, lamports: 1 })],
      }),
    );
    expect(v.join()).toMatch(/tidak diizinkan/);
  });

  it("tip Jito ke akun tip resmi diizinkan, di atas batas ditolak", () => {
    const tip = (lamports: number) =>
      run(
        launchTx({
          master: m,
          mint,
          extra: [
            SystemProgram.transfer({ fromPubkey: m, toPubkey: new PublicKey(JITO_TIP), lamports }),
          ],
        }),
      );
    expect(tip(500_000)).toEqual([]);
    expect(tip(5_000_000).join()).toMatch(/melebihi batas/);
  });

  it("program asing (mis. SPL Token) ditolak untuk tujuan launch", () => {
    const v = run(
      launchTx({
        master: m,
        mint,
        extra: [
          SystemProgram.assign({ accountPubkey: m, programId: Keypair.generate().publicKey }),
        ],
      }),
    );
    expect(v.join()).toMatch(/tidak diizinkan/);
  });
});

describe("SignerService", () => {
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

  async function setup(overrides: Parameters<typeof testSetup>[0] = {}) {
    const { master, config } = testSetup(overrides);
    const chain = new FakeSignerChain();
    const service = new SignerService({ db, chain, master, config });
    const job = await seedJob(db);
    const { mint } = await service.deriveMint(job.id, rid("req-mint"));
    await db.launchJob.update({ where: { id: job.id }, data: { mintAddress: mint } });
    const tx = launchTx({ master: master.publicKey, mint: new PublicKey(mint) });
    return { master, config, chain, service, job, mint, tx };
  }

  describe("launch pair di luar registri", () => {
    const quote = Keypair.generate().publicKey.toBase58();
    const configId = Keypair.generate().publicKey.toBase58();

    async function setupCustom() {
      const s = await setup();
      await db.token.update({
        where: { id: s.job.tokenId },
        data: { quoteMint: quote, quoteConfigId: configId },
      });
      const master = s.master.publicKey.toBase58();
      const ata = associatedTokenAddress(master, quote, TOKEN_PROGRAM);
      const tx = launchTx({
        master: s.master.publicKey,
        mint: new PublicKey(s.mint),
        configId,
        pool: launchPoolAddress(s.config.platform, s.mint, quote),
        extra: [createAtaIdempotentIx(master, ata, master, quote, TOKEN_PROGRAM)],
      });
      return { ...s, tx };
    }

    it("global config tidak terbukti milik quote job → ditolak sebelum simulasi", async () => {
      const { service, job, tx, chain } = await setupCustom();
      await expect(
        service.sign({ purpose: "launch", jobId: job.id, transaction: b64(tx) }, rid("c1")),
      ).rejects.toMatchObject({ code: "policy_violation", message: "pair job tidak dikenal" });
      chain.launchConfigs.set(configId, Keypair.generate().publicKey.toBase58());
      await expect(
        service.sign({ purpose: "launch", jobId: job.id, transaction: b64(tx) }, rid("c2")),
      ).rejects.toMatchObject({ code: "policy_violation" });
      expect(chain.simulations).toBe(0);
    });

    it("global config cocok on-chain → ditandatangani, termasuk ATA quote master", async () => {
      const { service, job, tx, chain } = await setupCustom();
      chain.launchConfigs.set(configId, quote);
      const res = await service.sign(
        { purpose: "launch", jobId: job.id, transaction: b64(tx) },
        rid("c3"),
      );
      expect(res.signature).toBeTruthy();
    });
  });

  it("menandatangani launch valid dengan master + mint, mencatat audit & pengeluaran", async () => {
    const { service, job, tx, master, mint } = await setup();
    const res = await service.sign(
      { purpose: "launch", jobId: job.id, transaction: b64(tx) },
      rid("r1"),
    );
    const signed = VersionedTransaction.deserialize(Buffer.from(res.transaction, "base64"));
    expect(signed.signatures.every((s) => s.some((b) => b !== 0))).toBe(true);
    const keys = signed.message.staticAccountKeys.slice(0, 2).map((k) => k.toBase58());
    expect(keys).toEqual([master.publicKey.toBase58(), mint]);
    expect(res.spendLamports).toBe("20622000");
    const audit = await db.auditEvent.findMany({
      where: { action: "signer.sign", requestId: rid("r1") },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.result).toBe("signed");
    expect(audit[0]!.txSignature).toBe(res.signature);
    // P5: pubkey mint tidak muncul di audit.
    const all = await db.auditEvent.findMany({
      where: { requestId: { in: [rid("r1"), rid("req-mint")] } },
    });
    expect(JSON.stringify(all)).not.toContain(mint);
    expect(await db.signerSpend.count()).toBe(1);
  });

  it("emergency pause menolak semua tanda tangan (retryable) dan tercatat", async () => {
    const { service, job, tx, chain } = await setup();
    await service.setPaused(true, "test", "incident drill", rid("p1"));
    await expect(
      service.sign({ purpose: "launch", jobId: job.id, transaction: b64(tx) }, rid("r2")),
    ).rejects.toMatchObject({ code: "paused", retryable: true });
    expect(chain.simulations).toBe(0);
    const audit = await db.auditEvent.findFirst({ where: { requestId: rid("r2") } });
    expect(audit?.result).toBe("rejected:paused");
    await service.setPaused(false, "test", "drill over", rid("p2"));
    await expect(
      service.sign({ purpose: "launch", jobId: job.id, transaction: b64(tx) }, rid("r3")),
    ).resolves.toMatchObject({ signature: expect.any(String) });
  });

  it("SIGNER_PAUSED=1 tidak bisa di-resume lewat flag", async () => {
    const { service } = await setup({ envPaused: true });
    await service.setPaused(false, "test", "try resume", null);
    expect(await service.isPaused()).toBe(true);
  });

  it("simulasi gagal → tidak ditandatangani", async () => {
    const { service, job, tx, chain } = await setup();
    chain.simErr = { InstructionError: [0, { Custom: 6002 }] };
    await expect(
      service.sign({ purpose: "launch", jobId: job.id, transaction: b64(tx) }, null),
    ).rejects.toMatchObject({ code: "simulation_failed", retryable: false });
    chain.simErr = "BlockhashNotFound";
    await expect(
      service.sign({ purpose: "launch", jobId: job.id, transaction: b64(tx) }, null),
    ).rejects.toMatchObject({ code: "simulation_failed", retryable: true });
    expect(await db.signerSpend.count()).toBe(0);
  });

  it("batas per transaksi dan per 24 jam", async () => {
    const { service, job, tx, chain } = await setup({
      policy: {
        ...SIGNER_POLICY,
        maxLamportsPerTx: 30_000_000,
        maxLamportsPer24h: 50_000_000,
        maxTxPer24h: 10,
        maxLamportsPerEconomicTx: 3_000_000,
      },
    });
    chain.spend = 40_000_000n;
    await expect(
      service.sign({ purpose: "launch", jobId: job.id, transaction: b64(tx) }, null),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
    chain.spend = 20_000_000n;
    await service.sign({ purpose: "launch", jobId: job.id, transaction: b64(tx) }, null);
    // Signature sama tidak boleh dicatat dua kali → bangun transaksi dengan blockhash lain.
    const tx2 = launchTx({ master: testMaster(service), mint: tx.message.staticAccountKeys[1]! });
    tx2.message.recentBlockhash = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";
    await service.sign({ purpose: "launch", jobId: job.id, transaction: b64(tx2) }, null);
    const tx3 = launchTx({ master: testMaster(service), mint: tx.message.staticAccountKeys[1]! });
    tx3.message.recentBlockhash = "8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKh";
    await expect(
      service.sign({ purpose: "launch", jobId: job.id, transaction: b64(tx3) }, null),
    ).rejects.toMatchObject({ code: "limit_exceeded", message: expect.stringMatching(/24 jam/) });
  });

  it("job harus berstatus submitting dan mint harus turunan signer", async () => {
    const { service, job, tx } = await setup();
    await db.launchJob.update({ where: { id: job.id }, data: { status: "confirming" } });
    await expect(
      service.sign({ purpose: "launch", jobId: job.id, transaction: b64(tx) }, null),
    ).rejects.toMatchObject({ code: "policy_violation" });
    await db.launchJob.update({
      where: { id: job.id },
      data: { status: "submitting", mintAddress: Keypair.generate().publicKey.toBase58() },
    });
    await expect(
      service.sign({ purpose: "launch", jobId: job.id, transaction: b64(tx) }, null),
    ).rejects.toMatchObject({ code: "policy_violation" });
  });

  it("refund deposit hanya ke pembayar deposit dengan jumlah persis", async () => {
    const { service, job, master } = await setup();
    const payer = Keypair.generate().publicKey;
    await db.launchDeposit.create({
      data: {
        jobId: job.id,
        depositSignature: "dep-sig",
        payer: payer.toBase58(),
        lamports: 100_000_000,
        status: "refund_pending",
      },
    });
    const thief = Keypair.generate().publicKey;
    await expect(
      service.sign(
        {
          purpose: "deposit_refund",
          jobId: job.id,
          transaction: b64(refundTx(master.publicKey, thief, 100_000_000)),
        },
        null,
      ),
    ).rejects.toMatchObject({ code: "policy_violation" });
    await expect(
      service.sign(
        {
          purpose: "deposit_refund",
          jobId: job.id,
          transaction: b64(refundTx(master.publicKey, payer, 200_000_000)),
        },
        null,
      ),
    ).rejects.toMatchObject({ code: "policy_violation" });
    const svcChain = (service as unknown as { deps: { chain: FakeSignerChain } }).deps.chain;
    svcChain.spend = 100_000_000n;
    await expect(
      service.sign(
        {
          purpose: "deposit_refund",
          jobId: job.id,
          transaction: b64(refundTx(master.publicKey, payer, 100_000_000)),
        },
        null,
      ),
    ).resolves.toMatchObject({ signature: expect.any(String) });
  });

  it("satu transaksi hidup per operasi: refund tidak bisa ditandatangani dua kali", async () => {
    const { service, job, master, chain } = await setup();
    const payer = Keypair.generate().publicKey;
    await db.launchDeposit.create({
      data: {
        jobId: job.id,
        depositSignature: "dep-sig-2",
        payer: payer.toBase58(),
        lamports: 100_000_000,
        status: "refund_pending",
      },
    });
    chain.spend = 100_000_000n;
    const req = (blockhash = BLOCKHASH) => {
      const tx = refundTx(master.publicKey, payer, 100_000_000);
      tx.message.recentBlockhash = blockhash;
      return { purpose: "deposit_refund" as const, jobId: job.id, transaction: b64(tx) };
    };
    const first = await service.sign(req(), null);
    const spend = await db.signerSpend.findUniqueOrThrow({ where: { signature: first.signature } });
    expect(spend.blockhash).toBe(BLOCKHASH);

    // Blockhash transaksi pertama masih hidup → ditolak sementara (worker mencoba lagi nanti).
    chain.liveBlockhashes.add(BLOCKHASH);
    await expect(service.sign(req(), null)).rejects.toMatchObject({
      code: "policy_violation",
      retryable: true,
    });
    // Transaksi pertama sudah mendarat → ditolak permanen.
    chain.liveBlockhashes.clear();
    chain.landed.add(first.signature);
    await expect(service.sign(req(), null)).rejects.toMatchObject({
      code: "policy_violation",
      retryable: false,
    });
    expect(await db.signerSpend.count()).toBe(1);

    // Tidak mendarat dan blockhash kedaluwarsa → transaksi pengganti boleh ditandatangani.
    chain.landed.clear();
    await expect(
      service.sign(req(Keypair.generate().publicKey.toBase58()), null),
    ).resolves.toMatchObject({
      signature: expect.any(String),
    });
    expect(await db.signerSpend.count()).toBe(2);
  });

  it("RPC timeout saat simulasi → rpc_unavailable (retryable), tidak ditandatangani", async () => {
    const { service, job, tx, chain } = await setup();
    chain.unavailable = true;
    await expect(
      service.sign({ purpose: "launch", jobId: job.id, transaction: b64(tx) }, null),
    ).rejects.toMatchObject({ code: "rpc_unavailable", retryable: true });
    expect(await db.signerSpend.count()).toBe(0);
  });

  it("menolak keypair yang bukan master wallet platform", () => {
    const { config } = testSetup();
    expect(
      () =>
        new SignerService({ db, chain: new FakeSignerChain(), master: Keypair.generate(), config }),
    ).toThrow(/bukan master wallet/);
  });

  describe("HTTP", () => {
    it("tanpa token → 401; /health tanpa token; pause lewat API, resume tidak ada", async () => {
      const { service, config, job, tx } = await setup();
      const app = buildSignerApp(service, config);
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({ status: "ok", paused: false });
      expect(health.body).not.toMatch(/secret/i);

      const noAuth = await app.inject({
        method: "POST",
        url: "/v1/sign",
        payload: { purpose: "launch", jobId: job.id, transaction: b64(tx) },
      });
      expect(noAuth.statusCode).toBe(401);
      const wrong = await app.inject({
        method: "POST",
        url: "/v1/launch/mint",
        headers: { authorization: "Bearer wrong" },
        payload: { jobId: job.id },
      });
      expect(wrong.statusCode).toBe(401);

      const auth = { authorization: `Bearer ${config.authTokens[0]!.token}` };
      const signed = await app.inject({
        method: "POST",
        url: "/v1/sign",
        headers: auth,
        payload: { purpose: "launch", jobId: job.id, transaction: b64(tx) },
      });
      expect(signed.statusCode).toBe(200);

      const bad = await app.inject({
        method: "POST",
        url: "/v1/sign",
        headers: auth,
        payload: { purpose: "x" },
      });
      expect(bad.statusCode).toBe(400);

      const pause = await app.inject({
        method: "POST",
        url: "/v1/pause",
        headers: auth,
        payload: { reason: "drill" },
      });
      expect(pause.json()).toEqual({ paused: true });
      const resume = await app.inject({
        method: "POST",
        url: "/v1/resume",
        headers: auth,
        payload: {},
      });
      expect(resume.statusCode).toBe(404);
      const paused = await app.inject({
        method: "POST",
        url: "/v1/sign",
        headers: auth,
        payload: { purpose: "launch", jobId: job.id, transaction: b64(tx) },
      });
      expect(paused.statusCode).toBe(503);
      expect(paused.json().error).toMatchObject({ code: "paused", retryable: true });
      await app.close();
    });

    it("F12: token per worker dengan cakupan tujuan (launch ≠ economic)", async () => {
      const launchToken = "L".repeat(40);
      const economicToken = "E".repeat(40);
      const { service, job, tx } = await setup();
      const app = buildSignerApp(service, {
        authTokens: [
          { token: launchToken, scope: "launch" },
          { token: economicToken, scope: "economic" },
        ],
      });
      const post = (token: string, url: string, payload: Record<string, unknown>) =>
        app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload });

      // Token economic tidak boleh meminta mint / tanda tangan launch.
      const mint = await post(economicToken, "/v1/launch/mint", { jobId: job.id });
      expect(mint.statusCode).toBe(401);
      expect(mint.json().error.code).toBe("unauthorized");
      const launchByEconomic = await post(economicToken, "/v1/sign", {
        purpose: "launch",
        jobId: job.id,
        transaction: b64(tx),
      });
      expect(launchByEconomic.statusCode).toBe(401);
      // Token launch tidak boleh meminta tujuan ekonomi (ditolak sebelum DB disentuh).
      const buybackByLaunch = await post(launchToken, "/v1/sign", {
        purpose: "buyback",
        opId: randomUUID(),
        transaction: b64(tx),
      });
      expect(buybackByLaunch.statusCode).toBe(401);
      expect(buybackByLaunch.json().error.message).toMatch(/cakupan launch/);
      // Token launch untuk tujuannya sendiri: lolos.
      const ok = await post(launchToken, "/v1/sign", {
        purpose: "launch",
        jobId: job.id,
        transaction: b64(tx),
      });
      expect(ok.statusCode).toBe(200);
      // Pause boleh dengan token mana pun (resume tetap hanya CLI).
      const pause = await post(economicToken, "/v1/pause", { reason: "drill" });
      expect(pause.json()).toEqual({ paused: true });
      await app.close();
    });
  });
});

function testMaster(service: SignerService): PublicKey {
  return (service as unknown as { deps: { master: Keypair } }).deps.master.publicKey;
}
