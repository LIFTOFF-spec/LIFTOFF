/**
 * Raydium LaunchLab: membangun transaksi create (tanpa initial buy) lewat Platform PDA LIFTOFF,
 * dengan master wallet sebagai creator & payer (D3), dan memverifikasi hasilnya on-chain.
 *
 * Token baru: base mint Token-2022 6 desimal (`initialize_with_token2022`, metadata di ekstensi
 * mint) dengan parameter dari `StonkFunAdapter.launchPricing` (configId, platform standard,
 * raise mentah, allow-config lalu curve-rule sebagai dua akun terakhir) — syarat adopsi StonkFun. Jalur SPL klasik
 * (`initialize_v2`) tetap ada untuk pricing `baseTokenProgram: "spl"` (token lama).
 *
 * Transaksi dibangun TANPA tanda tangan: worker tidak memegang key apa pun. Signer service
 * menambahkan tanda tangan master wallet dan mint keypair.
 */
import {
  ALL_PROGRAM_ID,
  DEVNET_PROGRAM_ID,
  getLaunchpadPoolMintAProgram,
  getPdaLaunchpadAuth,
  getPdaLaunchpadPoolId,
  getPdaLaunchpadVaultId,
  getPdaPlatformAllowConfig,
  getPdaPlatformCurveRule,
  initializeWithToken2022,
  LaunchpadConfig,
  LaunchpadPool,
  PlatformConfig,
  Raydium,
  TxVersion,
  updatePlatformConfig,
} from "@raydium-io/raydium-sdk-v2";
import { createHash } from "node:crypto";
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  STONKFUN_BASE_DECIMALS,
  type PairConfig,
  type PlatformAddresses,
  type StonkFunLaunchPricing,
} from "@liftoff/shared";
import {
  associatedTokenAddress,
  createAtaIdempotentIx,
  isTokenProgram,
  mintProgramOf,
  NATIVE_MINT,
  parseMintAccount,
  unsupportedQuoteReason,
} from "./token-program";

/** Discriminator Anchor instruksi `initialize_v2` LaunchLab (create pool + mint SPL + metadata). */
export const LAUNCHLAB_INITIALIZE_V2 = "4399af27da102620";
/** Discriminator `initialize_with_token2022` (base mint Token-2022, metadata di ekstensi mint). */
export const LAUNCHLAB_INITIALIZE_TOKEN2022 = "25be7ede2c9aab11";

/**
 * Posisi akun di instruksi `initialize_v2` / `initialize_with_token2022` yang diperiksa signer
 * (sama di kedua varian): 0 payer, 1 creator, 3 platform_config, 5 pool_state, 6 base_mint.
 */
export const LAUNCHLAB_INIT_ACCOUNTS = { payer: 0, creator: 1, platform: 3, pool: 5, mint: 6 };

/**
 * Jumlah akun tetap tiap varian create (SDK Raydium v2 0.2.74-alpha, `initializeV2` /
 * `initializeWithToken2022`). Sesudahnya hanya boleh: allow-config lalu curve-rule (read-only).
 */
export const LAUNCHLAB_INIT_FIXED_ACCOUNTS: Record<string, number> = {
  [LAUNCHLAB_INITIALIZE_V2]: 18,
  [LAUNCHLAB_INITIALIZE_TOKEN2022]: 15,
};

/**
 * PDA tambahan create untuk (program, platform, global config): allow-config
 * `["platform_allow_config", platform, config]` dan curve-rule
 * `["platform_curve_rule", platform, config]`. Dipakai untuk mencocokkan alamat dari StonkFun,
 * oleh builder, dan oleh signer.
 */
export function launchAccountPdas(programId: string, platformId: string, configId: string) {
  const program = new PublicKey(programId);
  const platform = new PublicKey(platformId);
  const config = new PublicKey(configId);
  return {
    allowConfigId: getPdaPlatformAllowConfig(program, platform, config).publicKey.toBase58(),
    curveRuleId: getPdaPlatformCurveRule(program, platform, config).publicKey.toBase58(),
  };
}

/** Discriminator Anchor `update_platform_config` (sha256("global:update_platform_config")[0..8]). */
export const LAUNCHLAB_UPDATE_PLATFORM_CONFIG = createHash("sha256")
  .update("global:update_platform_config")
  .digest()
  .subarray(0, 8)
  .toString("hex");

/** Indeks varian `updateFeeRate` di argumen `update_platform_config` (u8 index + u64 value). */
export const PLATFORM_UPDATE_FEE_RATE_INDEX = 3;

/**
 * Instruksi admin platform: ubah `feeRate` (per 1_000_000) Platform PDA LIFTOFF. Berlaku
 * seketika untuk SEMUA koin (Tahap 1). Hanya dibangun & ditandatangani di apps/signer.
 */
export function buildPlatformFeeRateIx(
  platform: PlatformAddresses,
  feeRate: number,
): TransactionInstruction {
  return updatePlatformConfig(
    new PublicKey(platform.launchlabProgram),
    new PublicKey(platform.masterWallet),
    new PublicKey(platform.platformId),
    { type: "updateFeeRate", value: new BN(feeRate) },
  );
}

/** `feeRate` & `creatorFeeRate` Platform PDA saat ini (on-chain). */
export async function readPlatformFeeRates(connection: Connection, platform: PlatformAddresses) {
  const cfg = await readPlatformConfig(connection, platform);
  return {
    feeRate: Number(cfg.feeRate.toString()),
    creatorFeeRate: Number(cfg.creatorFeeRate.toString()),
  };
}

export type PlatformConfigState = ReturnType<typeof PlatformConfig.decode>;

export async function readPlatformConfig(
  connection: Connection,
  platform: PlatformAddresses,
): Promise<PlatformConfigState> {
  const info = await connection.getAccountInfo(new PublicKey(platform.platformId), "confirmed");
  if (!info) throw new Error("platform config LIFTOFF tidak ditemukan on-chain");
  return PlatformConfig.decode(info.data);
}

/** Indeks varian `updateAll` di argumen `update_platform_config`. */
export const PLATFORM_UPDATE_ALL_INDEX = 8;

const cString = (bytes: number[]) => Buffer.from(bytes).toString("utf8").replace(/\0+$/, "");

/** Bidang yang ditulis `updateAll` (selain fee, semuanya WAJIB sama dengan on-chain). */
export interface PlatformUpdateAllArgs {
  platformClaimFeeWallet: string;
  platformLockNftWallet: string;
  platformScale: bigint;
  creatorScale: bigint;
  burnScale: bigint;
  feeRate: bigint;
  name: string;
  web: string;
  img: string;
  transferFeeExtensionAuth: string;
  creatorFeeRate: bigint;
  platformVestingScale: bigint;
  platformVestingWallet: string;
  /** Akun ke-3 instruksi (cpConfigId). */
  cpConfigId: string;
}

/** Nilai `updateAll` dari state on-chain saat ini, dengan fee diganti. */
export function updateAllArgsFrom(
  cfg: PlatformConfigState,
  fees: { feeRate: number; creatorFeeRate: number },
): PlatformUpdateAllArgs {
  return {
    platformClaimFeeWallet: cfg.platformClaimFeeWallet.toBase58(),
    platformLockNftWallet: cfg.platformLockNftWallet.toBase58(),
    platformScale: BigInt(cfg.platformScale.toString()),
    creatorScale: BigInt(cfg.creatorScale.toString()),
    burnScale: BigInt(cfg.burnScale.toString()),
    feeRate: BigInt(fees.feeRate),
    name: cString(cfg.name),
    web: cString(cfg.web),
    img: cString(cfg.img),
    transferFeeExtensionAuth: cfg.transferFeeExtensionAuth.toBase58(),
    creatorFeeRate: BigInt(fees.creatorFeeRate),
    platformVestingScale: BigInt(cfg.platformVestingScale.toString()),
    platformVestingWallet: cfg.platformVestingWallet.toBase58(),
    cpConfigId: cfg.cpConfigId.toBase58(),
  };
}

/**
 * Instruksi admin platform: ubah `feeRate` DAN `creatorFeeRate` sekaligus. Program hanya punya
 * varian `updateAll` untuk creator fee, jadi semua bidang lain diisi ulang PERSIS dari state
 * on-chain (dicek lagi oleh policy signer). Berlaku seketika untuk semua koin.
 */
export function buildPlatformFeeSyncIx(
  platform: PlatformAddresses,
  args: PlatformUpdateAllArgs,
): TransactionInstruction {
  const pk = (s: string) => new PublicKey(s);
  const bn = (v: bigint) => new BN(v.toString());
  return updatePlatformConfig(
    pk(platform.launchlabProgram),
    pk(platform.masterWallet),
    pk(platform.platformId),
    {
      type: "updateAll",
      value: {
        platformClaimFeeWallet: pk(args.platformClaimFeeWallet),
        platformLockNftWallet: pk(args.platformLockNftWallet),
        platformVestingWallet: pk(args.platformVestingWallet),
        cpConfigId: pk(args.cpConfigId),
        migrateCpLockNftScale: {
          platformScale: bn(args.platformScale),
          creatorScale: bn(args.creatorScale),
          burnScale: bn(args.burnScale),
        },
        feeRate: bn(args.feeRate),
        name: args.name,
        web: args.web,
        img: args.img,
        transferFeeExtensionAuth: pk(args.transferFeeExtensionAuth),
        creatorFeeRate: bn(args.creatorFeeRate),
        platformVestingScale: bn(args.platformVestingScale),
      },
    },
  );
}

/** Decode data instruksi `update_platform_config` varian `updateAll` (untuk policy signer). */
export function decodeUpdateAllData(
  data: Buffer,
): Omit<PlatformUpdateAllArgs, "cpConfigId"> | null {
  try {
    let o = 8;
    if (data[o] !== PLATFORM_UPDATE_ALL_INDEX) return null;
    o += 1;
    const key = () => {
      const v = new PublicKey(data.subarray(o, o + 32)).toBase58();
      o += 32;
      return v;
    };
    const u64 = () => {
      const v = data.readBigUInt64LE(o);
      o += 8;
      return v;
    };
    const str = () => {
      const len = data.readUInt32LE(o);
      const v = data.subarray(o + 4, o + 4 + len).toString("utf8");
      o += 4 + len;
      return v;
    };
    const out = {
      platformClaimFeeWallet: key(),
      platformLockNftWallet: key(),
      platformScale: u64(),
      creatorScale: u64(),
      burnScale: u64(),
      feeRate: u64(),
      name: str(),
      web: str(),
      img: str(),
      transferFeeExtensionAuth: key(),
      creatorFeeRate: u64(),
      platformVestingScale: u64(),
      platformVestingWallet: key(),
    };
    return o === data.length ? out : null;
  } catch {
    return null;
  }
}

export interface LaunchTokenParams {
  name: string;
  symbol: string;
  /** URI metadata JSON (Metaplex). */
  uri: string;
  pair: PairConfig;
}

export interface BuildLaunchParams extends LaunchTokenParams {
  connection: Connection;
  platform: PlatformAddresses;
  mint: string;
  /** Parameter create dari `StonkFunAdapter.launchPricing` (bukan konstanta). */
  pricing: StonkFunLaunchPricing;
  /** Tip Jito (hanya jalur `jito`, mainnet). */
  tip?: { account: string; lamports: number };
  /**
   * Target graduation (satuan terkecil quote) pengganti, KHUSUS devnet untuk menguji graduation
   * dengan SOL kecil (Tahap 5). Worker menolaknya di luar devnet.
   */
  totalFundRaisingOverride?: bigint;
}

export interface BuiltLaunchTx {
  transaction: VersionedTransaction;
  lastValidBlockHeight: number;
  pool: string;
}

export function launchPoolAddress(platform: PlatformAddresses, mint: string, quoteMint: string) {
  return getPdaLaunchpadPoolId(
    new PublicKey(platform.launchlabProgram),
    new PublicKey(mint),
    new PublicKey(quoteMint),
  ).publicKey.toBase58();
}

const raydiumCache = new WeakMap<Connection, Promise<Raydium>>();

/** Cluster SDK Raydium dari program LaunchLab platform. Program lain ditolak. */
function sdkClusterOf(launchlabProgram: string): "mainnet" | "devnet" {
  if (launchlabProgram === ALL_PROGRAM_ID.LAUNCHPAD_PROGRAM.toBase58()) return "mainnet";
  if (launchlabProgram === DEVNET_PROGRAM_ID.LAUNCHPAD_PROGRAM.toBase58()) return "devnet";
  throw new Error("program LaunchLab tidak dikenal SDK Raydium");
}

function raydiumFor(
  connection: Connection,
  owner: PublicKey,
  cluster: "mainnet" | "devnet",
): Promise<Raydium> {
  let r = raydiumCache.get(connection);
  if (!r) {
    r = Raydium.load({
      connection,
      // Owner = PublicKey: SDK membangun transaksi tanpa menandatanganinya.
      owner,
      cluster,
      disableFeatureCheck: true,
      disableLoadToken: true,
      blockhashCommitment: "confirmed",
    });
    r.catch(() => raydiumCache.delete(connection));
    raydiumCache.set(connection, r);
  }
  return r;
}

/** Quote mint sebuah global config LaunchLab; null bila akun bukan milik program LaunchLab. */
export async function globalConfigQuoteMint(
  connection: Connection,
  platform: PlatformAddresses,
  configId: string,
): Promise<string | null> {
  const info = await connection.getAccountInfo(new PublicKey(configId), "confirmed");
  if (!info || info.owner.toBase58() !== platform.launchlabProgram) return null;
  return LaunchpadConfig.decode(info.data).mintB.toBase58();
}

/** Parameter pricing wajib cocok dengan pair & program yang dipakai sebelum membangun create. */
function assertPricing(p: BuildLaunchParams) {
  const pr = p.pricing;
  if (pr.quoteMint !== p.pair.mint || pr.configId !== p.pair.configId) {
    throw new Error("pricing StonkFun bukan untuk pair/config ini");
  }
  if (pr.launchlabProgram !== p.platform.launchlabProgram) {
    throw new Error("program LaunchLab pricing berbeda dengan platform");
  }
  if (pr.migrateType !== "cpmm") throw new Error("migrasi harus CPMM");
  if (pr.baseDecimals !== STONKFUN_BASE_DECIMALS) throw new Error("base mint harus 6 desimal");
  if (pr.allowConfigAvailable === false)
    throw new Error("platform menolak quote ini (allow-config)");
  if (pr.allowConfigRequired && !pr.allowConfigId) throw new Error("akun allow-config wajib");
  // Alamat akun tambahan wajib = PDA turunan lokal (bukan dipercaya dari API).
  const pdas = launchAccountPdas(pr.launchlabProgram, pr.platformId, pr.configId);
  if (pr.allowConfigId && pr.allowConfigId !== pdas.allowConfigId) {
    throw new Error("allow-config bukan PDA platform/config ini");
  }
  if (pr.curveRuleId && pr.curveRuleId !== pdas.curveRuleId) {
    throw new Error("curve-rule bukan PDA platform/config ini");
  }
}

export async function buildLaunchTransaction(p: BuildLaunchParams): Promise<BuiltLaunchTx> {
  assertPricing(p);
  // Mainnet = StonkFun: curve-rule mewajibkan base mint Token-2022 (jalur SPL hanya data devnet).
  if (
    sdkClusterOf(p.platform.launchlabProgram) === "mainnet" &&
    p.pricing.baseTokenProgram !== "token2022"
  ) {
    throw new Error("launch mainnet wajib base mint Token-2022 (aturan StonkFun)");
  }
  return p.pricing.baseTokenProgram === "token2022" ? buildToken2022Launch(p) : buildSplLaunch(p);
}

/**
 * Pagar terakhir untuk quote non-SOL, dibaca segar dari chain: desimal cocok, tanpa transfer fee atau
 * hook aktif (penerbit bisa menyalakan hook kapan saja). Mengembalikan instruksi pembuat ATA quote
 * master bila belum ada, supaya fee yang diteruskan StonkFun punya tujuan; rent-nya tertutup deposit
 * (BUILD_PLAN §7q). Pair SOL tidak berubah: jalurnya sudah terbukti di mainnet.
 */
async function checkQuoteForLaunch(
  p: BuildLaunchParams,
  quoteProgram: string,
): Promise<TransactionInstruction | null> {
  if (p.pair.mint === NATIVE_MINT) return null;
  const info = await p.connection.getAccountInfo(new PublicKey(p.pair.mint), "confirmed");
  const parsed = info ? parseMintAccount(info.owner.toBase58(), info.data) : null;
  if (!parsed) throw new Error("quote mint tidak ditemukan on-chain");
  if (parsed.decimals !== p.pair.decimals) throw new Error("desimal quote berbeda dengan on-chain");
  const reason = unsupportedQuoteReason(parsed);
  if (reason) throw new Error(reason);
  const master = p.platform.masterWallet;
  const ata = associatedTokenAddress(master, p.pair.mint, quoteProgram);
  if (await p.connection.getAccountInfo(new PublicKey(ata), "confirmed")) return null;
  return createAtaIdempotentIx(master, ata, master, p.pair.mint, quoteProgram);
}

/**
 * Create Token-2022: instruksi `initialize_with_token2022` dibangun langsung (SDK
 * `createLaunchpad` hanya memilih Token-2022 bila ada transfer fee — mode "reward" yang TIDAK
 * dipakai LIFTOFF). Tanpa transfer fee, tanpa dev buy (Spec Rule 6); allow-config (bila ada) lalu
 * curve-rule (bila ada) = akun terakhir, read-only (urutan StonkFun; SDK menambahkannya demikian).
 */
async function buildToken2022Launch(p: BuildLaunchParams): Promise<BuiltLaunchTx> {
  const pr = p.pricing;
  const master = new PublicKey(p.platform.masterWallet);
  const program = new PublicKey(pr.launchlabProgram);
  const mintA = new PublicKey(p.mint);
  const mintB = new PublicKey(p.pair.mint);
  const configId = new PublicKey(pr.configId);
  const cfgInfo = await p.connection.getAccountInfo(configId, "confirmed");
  if (!cfgInfo) throw new Error(`global config ${pr.configId} tidak ditemukan`);
  const cfg = LaunchpadConfig.decode(cfgInfo.data);
  if (cfg.mintB.toBase58() !== p.pair.mint) throw new Error("global config bukan untuk quote ini");
  if (Number(cfg.curveType) !== 0) throw new Error("hanya kurva constant product yang didukung");
  // Quote bisa SPL klasik atau Token-2022 (xStocks): akun program quote harus benar.
  const quoteProgram = await mintProgramOf(p.connection, p.pair.mint);
  const quoteAta = await checkQuoteForLaunch(p, quoteProgram);
  const poolId = getPdaLaunchpadPoolId(program, mintA, mintB).publicKey;
  const raise = p.totalFundRaisingOverride ?? BigInt(pr.totalFundRaisingB);
  const ix = initializeWithToken2022(
    program,
    master,
    master,
    configId,
    new PublicKey(pr.platformId),
    getPdaLaunchpadAuth(program).publicKey,
    poolId,
    mintA,
    mintB,
    getPdaLaunchpadVaultId(program, poolId, mintA).publicKey,
    getPdaLaunchpadVaultId(program, poolId, mintB).publicKey,
    new PublicKey(quoteProgram),
    pr.baseDecimals,
    p.name,
    p.symbol,
    p.uri,
    {
      type: "ConstantCurve",
      totalSellA: new BN(pr.totalSellA),
      migrateType: "cpmm",
      supply: new BN(pr.supply),
      totalFundRaisingB: new BN(raise.toString()),
    },
    new BN(0),
    new BN(0),
    new BN(0),
    pr.cpmmCreatorFeeOn,
    undefined, // tanpa transfer fee (mode standard)
    pr.allowConfigId ? new PublicKey(pr.allowConfigId) : undefined,
    pr.curveRuleId ? new PublicKey(pr.curveRuleId) : undefined,
  );
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ...(quoteAta ? [quoteAta] : []),
    ix,
  ];
  if (p.tip) {
    ixs.push(
      SystemProgram.transfer({
        fromPubkey: master,
        toPubkey: new PublicKey(p.tip.account),
        lamports: p.tip.lamports,
      }),
    );
  }
  const latest = await p.connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: master,
    recentBlockhash: latest.blockhash,
    instructions: ixs,
  }).compileToV0Message();
  return {
    transaction: new VersionedTransaction(message),
    lastValidBlockHeight: latest.lastValidBlockHeight,
    pool: poolId.toBase58(),
  };
}

/** Create SPL klasik lewat SDK `createLaunchpad` (jalur Tahap 1–9, token lama). */
async function buildSplLaunch(p: BuildLaunchParams): Promise<BuiltLaunchTx> {
  const pr = p.pricing;
  const master = new PublicKey(p.platform.masterWallet);
  const raydium = await raydiumFor(p.connection, master, sdkClusterOf(p.platform.launchlabProgram));
  const { transactions } = await raydium.launchpad.createLaunchpad({
    programId: new PublicKey(pr.launchlabProgram),
    platformId: new PublicKey(pr.platformId),
    configId: new PublicKey(pr.configId),
    mintA: new PublicKey(p.mint),
    decimals: pr.baseDecimals,
    mintBDecimals: p.pair.decimals,
    name: p.name,
    symbol: p.symbol,
    uri: p.uri,
    migrateType: "cpmm",
    supply: new BN(pr.supply),
    totalSellA: new BN(pr.totalSellA),
    totalFundRaisingB: new BN(
      (p.totalFundRaisingOverride ?? BigInt(pr.totalFundRaisingB)).toString(),
    ),
    buyAmount: new BN(0),
    createOnly: true,
    // SDK menurunkan PDA yang sama (sudah dicocokkan di assertPricing) sebelum curve-rule.
    platformAllowConfig: !!pr.allowConfigId,
    feePayer: master,
    txVersion: TxVersion.V0,
    ...(p.tip
      ? { txTipConfig: { address: new PublicKey(p.tip.account), amount: new BN(p.tip.lamports) } }
      : {}),
  });
  if (transactions.length !== 1) {
    throw new Error(`createLaunchpad menghasilkan ${transactions.length} transaksi, diharapkan 1`);
  }
  const tx = transactions[0]!;
  // Blockhash segar yang batas block height-nya kita ketahui (untuk deteksi kedaluwarsa).
  const latest = await p.connection.getLatestBlockhash("confirmed");
  tx.message.recentBlockhash = latest.blockhash;
  return {
    transaction: tx,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    pool: launchPoolAddress(p.platform, p.mint, p.pair.mint),
  };
}

export type LaunchVerification =
  | { ok: true; pool: string; supply: string; tokenProgram: string }
  | { ok: false; exists: boolean; reason: string };

/**
 * Token boleh `live` hanya jika mint DAN pool terverifikasi on-chain: mint milik SPL Token
 * (token lama) atau Token-2022 (token baru) — sama dengan bit program di pool —, 6 desimal,
 * supply = supply pool, pool LaunchLab ada untuk (mint, quote) dengan platform yang diharapkan
 * dan creator master wallet. `exists` = ada jejak launch (mint atau pool) walau belum lengkap.
 */
export async function verifyLaunchOnChain(
  connection: Connection,
  p: {
    platform: PlatformAddresses;
    mint: string;
    pair: PairConfig;
    /** Platform launch (default Platform PDA LIFTOFF; mainnet: platform standard StonkFun). */
    platformId?: string;
  },
): Promise<LaunchVerification> {
  const pool = launchPoolAddress(p.platform, p.mint, p.pair.mint);
  const [mintInfo, poolInfo] = await connection.getMultipleAccountsInfo(
    [new PublicKey(p.mint), new PublicKey(pool)],
    "confirmed",
  );
  if (!mintInfo && !poolInfo) return { ok: false, exists: false, reason: "mint & pool belum ada" };
  if (!mintInfo) return { ok: false, exists: true, reason: "mint belum ada" };
  if (!poolInfo) return { ok: false, exists: true, reason: "pool belum ada" };
  const tokenProgram = mintInfo.owner.toBase58();
  if (!isTokenProgram(tokenProgram) || mintInfo.data.length < 82) {
    return { ok: false, exists: true, reason: "akun mint bukan mint SPL Token / Token-2022" };
  }
  if (poolInfo.owner.toBase58() !== p.platform.launchlabProgram) {
    return { ok: false, exists: true, reason: "pool bukan milik program LaunchLab" };
  }
  const decoded = LaunchpadPool.decode(poolInfo.data);
  const supply = mintInfo.data.readBigUInt64LE(36);
  const decimals = mintInfo.data[44];
  const poolSupply = BigInt(decoded.supply.toString());
  if (decimals !== STONKFUN_BASE_DECIMALS || supply !== poolSupply || supply <= 0n) {
    return {
      ok: false,
      exists: true,
      reason: `mint tidak sesuai (desimal ${decimals}, supply ${supply}, supply pool ${poolSupply})`,
    };
  }
  const flagProgram = getLaunchpadPoolMintAProgram(decoded.mintProgramFlag).toBase58();
  if (flagProgram !== tokenProgram) {
    return { ok: false, exists: true, reason: "program mint ≠ bit program token di pool" };
  }
  const mismatch = (
    [
      ["mintA", decoded.mintA.toBase58(), p.mint],
      ["mintB", decoded.mintB.toBase58(), p.pair.mint],
      ["platformId", decoded.platformId.toBase58(), p.platformId ?? p.platform.platformId],
      ["configId", decoded.configId.toBase58(), p.pair.configId],
      ["creator", decoded.creator.toBase58(), p.platform.masterWallet],
    ] as const
  ).find(([, got, want]) => got !== want);
  if (mismatch) {
    return {
      ok: false,
      exists: true,
      reason: `pool ${mismatch[0]} = ${mismatch[1]}, harus ${mismatch[2]}`,
    };
  }
  return { ok: true, pool, supply: supply.toString(), tokenProgram };
}
