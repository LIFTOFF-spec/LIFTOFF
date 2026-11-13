import { createPrismaClient, type Db } from "@liftoff/db";
import { prepareTestDatabase, RESETTABLE_TABLES } from "@liftoff/db/testing";
import { pairsFor, platformFor, SIGNER_POLICY } from "@liftoff/shared";
import { encodeTransaction } from "@liftoff/solana";
import { LAUNCHLAB_INITIALIZE_V2, launchPoolAddress } from "@liftoff/solana/launchlab";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type { SignerConfig } from "./config";
import type { PoolQuote, SignerChain, SimulationResult } from "./service";

let shared: Db | null = null;

export async function testDb(): Promise<Db> {
  shared ??= createPrismaClient(await prepareTestDatabase("liftoff_test_signer"));
  return shared;
}

export async function resetDb(db: Db) {
  await db.$executeRawUnsafe(
    `TRUNCATE ${RESETTABLE_TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
}

/**
 * Master wallet test: keypair acak, tetapi config platform-nya ditimpa agar masterWallet = pubkey
 * ini (keypair master devnet asli tidak pernah dipakai di test).
 */
export function testSetup(overrides: Partial<SignerConfig> = {}) {
  const master = Keypair.generate();
  const platform = { ...platformFor("devnet"), masterWallet: master.publicKey.toBase58() };
  const config: SignerConfig = {
    cluster: "devnet",
    platform,
    keypairPath: "/outside/repo/test.json",
    authTokens: [{ token: "t".repeat(40), scope: "all" }],
    host: "127.0.0.1",
    port: 0,
    rpcUrl: "http://rpc.invalid",
    backupRpcUrl: null,
    policy: { ...SIGNER_POLICY },
    maxTipLamports: 1_000_000,
    envPaused: false,
    ...overrides,
  };
  return { master, config, platform };
}

export const SOL_PAIR = pairsFor("devnet").find((p) => p.id === "sol")!;

export const BLOCKHASH = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";

/** Transaksi launch sintetis dengan susunan akun initialize_v2 asli (tanpa jaringan). */
export function launchTx(opts: {
  master: PublicKey;
  mint: PublicKey;
  platformId?: string;
  pool?: string;
  configId?: string;
  extra?: TransactionInstruction[];
  discriminator?: string;
  payer?: PublicKey;
}): VersionedTransaction {
  const platform = platformFor("devnet");
  const pool = opts.pool ?? launchPoolAddress(platform, opts.mint.toBase58(), SOL_PAIR.mint);
  const keys = [
    { pubkey: opts.payer ?? opts.master, isSigner: true, isWritable: true },
    { pubkey: opts.master, isSigner: true, isWritable: false },
    {
      pubkey: new PublicKey(opts.configId ?? SOL_PAIR.configId),
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: new PublicKey(opts.platformId ?? platform.platformId),
      isSigner: false,
      isWritable: true,
    },
    { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false },
    { pubkey: new PublicKey(pool), isSigner: false, isWritable: true },
    { pubkey: opts.mint, isSigner: true, isWritable: true },
  ];
  const ix = new TransactionInstruction({
    programId: new PublicKey(platform.launchlabProgram),
    keys,
    data: Buffer.concat([
      Buffer.from(opts.discriminator ?? LAUNCHLAB_INITIALIZE_V2, "hex"),
      Buffer.alloc(16),
    ]),
  });
  const message = new TransactionMessage({
    payerKey: opts.payer ?? opts.master,
    recentBlockhash: BLOCKHASH,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ix,
      ...(opts.extra ?? []),
    ],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

export function refundTx(
  master: PublicKey,
  to: PublicKey,
  lamports: number,
  extra: TransactionInstruction[] = [],
) {
  const message = new TransactionMessage({
    payerKey: master,
    recentBlockhash: BLOCKHASH,
    instructions: [
      SystemProgram.transfer({ fromPubkey: master, toPubkey: to, lamports }),
      ...extra,
    ],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

export const b64 = encodeTransaction;

/** RPC palsu: simulasi mengurangi saldo master sebesar `spend`. */
export class FakeSignerChain implements SignerChain {
  balanceLamports = 2_000_000_000n;
  spend = 20_617_000n;
  feeLamports = 5_000n;
  simErr: unknown = null;
  simulations = 0;
  unavailable = false;

  /** Signature yang dianggap sudah mendarat; blockhash yang masih hidup (default: kedaluwarsa). */
  landed = new Set<string>();
  liveBlockhashes = new Set<string>();

  cpConfigId = Keypair.generate().publicKey.toBase58();
  /** Mint Token-2022 (token baru); lainnya SPL klasik. */
  token2022 = new Set<string>();
  async mintProgram(mint: string) {
    return this.token2022.has(mint)
      ? "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
      : "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  }
  async signatureLanded(signature: string) {
    return this.landed.has(signature);
  }
  async blockhashValid(blockhash: string) {
    return this.liveBlockhashes.has(blockhash);
  }
  async lookupTables() {
    return [];
  }
  async platformCpConfigId() {
    return this.cpConfigId;
  }
  async balance() {
    if (this.unavailable)
      throw new (await import("@liftoff/solana")).RpcUnavailableError("timeout");
    return this.balanceLamports;
  }
  async fee() {
    return this.feeLamports;
  }

  /** Saldo akun token sebelum / sesudah simulasi (default: tidak berubah, 0). */
  tokenPre = new Map<string, bigint>();
  tokenPost = new Map<string, bigint>();
  async tokenBalances(accounts: string[]) {
    return accounts.map((a) => this.tokenPre.get(a) ?? 0n);
  }

  /** Quote pool on-chain palsu (F2). Default: expectedOut besar → minOut uji lama tetap lolos. */
  quote: PoolQuote = {
    route: "launchlab",
    pool: "pool",
    amountIn: 0n,
    expectedOut: 1_000n,
    cpmm: null,
  };
  quotes = 0;
  async quoteBuy(p: { amountIn: bigint }): Promise<PoolQuote> {
    this.quotes++;
    return { ...this.quote, amountIn: p.amountIn };
  }

  /** Global config LaunchLab → quote mint (pair di luar registri). */
  launchConfigs = new Map<string, string>();
  launchConfigQuoteMint(configId: string): Promise<string | null> {
    return Promise.resolve(this.launchConfigs.get(configId) ?? null);
  }

  /** F8: chain RPC cadangan (null = tidak dikonfigurasi). */
  backup: FakeSignerChain | null = null;

  async simulate(_tx: unknown, _watch: string, accounts: string[] = []): Promise<SimulationResult> {
    this.simulations++;
    return {
      err: this.simErr,
      logs: this.simErr ? ["Program log: Error: something failed"] : [],
      postLamports: this.balanceLamports - this.spend,
      postTokenAmounts: accounts.map((a) => this.tokenPost.get(a) ?? this.tokenPre.get(a) ?? 0n),
      unitsConsumed: 100_000,
    };
  }
}

/** Membuat user + token + launch job berstatus `status` di DB test. */
export async function seedJob(
  db: Db,
  opts: { status?: "queued" | "submitting" | "confirming"; mintAddress?: string | null } = {},
) {
  const user = await db.user.create({ data: { wallet: Keypair.generate().publicKey.toBase58() } });
  const token = await db.token.create({
    data: {
      name: "Test",
      ticker: "TEST",
      tickerNormalized: `test${Math.random().toString(36).slice(2, 8)}`,
      quoteMint: SOL_PAIR.mint,
      quoteConfigId: SOL_PAIR.configId,
      creatorUserId: user.id,
      launchStatus: opts.status ?? "submitting",
    },
  });
  return db.launchJob.create({
    data: {
      tokenId: token.id,
      userId: user.id,
      idempotencyKey: `key-${Math.random().toString(36).slice(2)}`,
      requestHash: "x",
      status: opts.status ?? "submitting",
      mintAddress: opts.mintAddress ?? null,
    },
  });
}
