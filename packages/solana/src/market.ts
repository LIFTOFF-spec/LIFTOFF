/**
 * Pembaca state pasar on-chain untuk indexer (Tahap 6): pool LaunchLab, pool CPMM hasil migrasi,
 * supply mint, akun token per mint (holder & distribusi LP), dan riwayat signature per pool.
 *
 * Hanya RPC standar (getAccountInfo, getMultipleAccountsInfo, getProgramAccounts,
 * getSignaturesForAddress, getTransaction), jadi jalan di RPC publik devnet maupun Helius.
 * Catatan PoC Tahap 1: getBlock gagal di devnet karena transaksi "version 1", jadi indexer
 * memakai getSignaturesForAddress per pool, bukan memindai blok.
 */
import {
  CpmmPoolInfoLayout,
  getPdaLaunchpadPoolId,
  LaunchpadPool,
  PlatformConfig,
} from "@raydium-io/raydium-sdk-v2";
import { PublicKey, type Connection } from "@solana/web3.js";
import type BN from "bn.js";
import {
  getTransactionAnyVersion,
  migratedCpmmPoolAddress,
  parseTradeTransaction,
  TOKEN_PROGRAM,
  type ParsedTradeTransaction,
  type TradePrograms,
} from "./trade";
import { mintProgramOf } from "./token-program";

const big = (bn: BN) => BigInt(bn.toString());

export interface LaunchPoolSnapshot {
  address: string;
  /** 0 trading, 1 curve penuh (menunggu migrasi), 2 sudah migrasi. */
  status: number;
  migrateType: number;
  mintDecimalsA: number;
  mintDecimalsB: number;
  supply: bigint;
  totalSellA: bigint;
  virtualA: bigint;
  virtualB: bigint;
  realA: bigint;
  realB: bigint;
  totalFundRaisingB: bigint;
  configId: string;
  platformId: string;
  mintA: string;
  mintB: string;
  creator: string;
}

export interface CpmmPoolSnapshot {
  address: string;
  configId: string;
  poolCreator: string;
  mintA: string;
  mintB: string;
  mintLp: string;
  mintProgramA: string;
  mintProgramB: string;
  /** Bit status cp-swap: 1 = deposit dimatikan, 2 = withdraw dimatikan, 4 = swap dimatikan. */
  status: number;
  /** Total LP yang pernah dicetak pool (termasuk yang dibakar saat migrasi). */
  lpAmount: bigint;
  openTime: bigint;
  enableCreatorFee: boolean;
  /** Cadangan bersih (saldo vault − fee protocol/fund/creator yang belum di-claim). */
  reserveA: bigint;
  reserveB: bigint;
}

export interface TokenAccountBalance {
  address: string;
  owner: string;
  amount: bigint;
}

export { UnsupportedTransactionError } from "./trade";

export interface MarketReaderOptions {
  launchlabProgram: string;
  cpmmProgram: string;
  platformId: string;
  /** Dipanggil sebelum setiap panggilan RPC (throttle rate limit). */
  beforeCall?: () => Promise<void>;
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  failed: boolean;
  blockTime: number | null;
}

export class MarketReader {
  private cpConfigId: string | null = null;
  readonly programs: TradePrograms;

  constructor(
    private readonly connection: Connection,
    private readonly opts: MarketReaderOptions,
  ) {
    this.programs = {
      launchlab: opts.launchlabProgram,
      cpmm: opts.cpmmProgram,
    };
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    await this.opts.beforeCall?.();
    return fn();
  }

  launchPoolAddress(mint: string, quoteMint: string): string {
    return getPdaLaunchpadPoolId(
      new PublicKey(this.programs.launchlab),
      new PublicKey(mint),
      new PublicKey(quoteMint),
    ).publicKey.toBase58();
  }

  /** Config CPMM tujuan migrasi platform (dibaca sekali per proses; berubah = platform baru). */
  async migrationConfigId(): Promise<string> {
    if (this.cpConfigId) return this.cpConfigId;
    const info = await this.call(() =>
      this.connection.getAccountInfo(new PublicKey(this.opts.platformId), "confirmed"),
    );
    if (!info) throw new Error("platform config tidak ditemukan on-chain");
    this.cpConfigId = PlatformConfig.decode(info.data).cpConfigId.toBase58();
    return this.cpConfigId;
  }

  async cpmmPoolAddress(mint: string, quoteMint: string): Promise<string> {
    return migratedCpmmPoolAddress(
      this.programs.cpmm,
      await this.migrationConfigId(),
      mint,
      quoteMint,
    );
  }

  async readLaunchPool(address: string): Promise<LaunchPoolSnapshot | null> {
    const info = await this.call(() =>
      this.connection.getAccountInfo(new PublicKey(address), "confirmed"),
    );
    if (!info || info.owner.toBase58() !== this.programs.launchlab) return null;
    const p = LaunchpadPool.decode(info.data);
    return {
      address,
      status: p.status,
      migrateType: p.migrateType,
      mintDecimalsA: p.mintDecimalsA,
      mintDecimalsB: p.mintDecimalsB,
      supply: big(p.supply),
      totalSellA: big(p.totalSellA),
      virtualA: big(p.virtualA),
      virtualB: big(p.virtualB),
      realA: big(p.realA),
      realB: big(p.realB),
      totalFundRaisingB: big(p.totalFundRaisingB),
      configId: p.configId.toBase58(),
      platformId: p.platformId.toBase58(),
      mintA: p.mintA.toBase58(),
      mintB: p.mintB.toBase58(),
      creator: p.creator.toBase58(),
    };
  }

  async readCpmmPool(address: string): Promise<CpmmPoolSnapshot | null> {
    const info = await this.call(() =>
      this.connection.getAccountInfo(new PublicKey(address), "confirmed"),
    );
    if (!info || info.owner.toBase58() !== this.programs.cpmm) return null;
    const cp = CpmmPoolInfoLayout.decode(info.data);
    const [vaultA, vaultB] = await this.call(() =>
      this.connection.getMultipleAccountsInfo([cp.vaultA, cp.vaultB], "confirmed"),
    );
    if (!vaultA || !vaultB) return null;
    return {
      address,
      configId: cp.configId.toBase58(),
      poolCreator: cp.poolCreator.toBase58(),
      mintA: cp.mintA.toBase58(),
      mintB: cp.mintB.toBase58(),
      mintLp: cp.mintLp.toBase58(),
      mintProgramA: cp.mintProgramA.toBase58(),
      mintProgramB: cp.mintProgramB.toBase58(),
      status: cp.status,
      lpAmount: big(cp.lpAmount),
      openTime: big(cp.openTime),
      enableCreatorFee: Boolean(cp.enableCreatorFee),
      reserveA:
        vaultA.data.readBigUInt64LE(64) -
        big(cp.protocolFeesMintA) -
        big(cp.fundFeesMintA) -
        big(cp.creatorFeesMintA),
      reserveB:
        vaultB.data.readBigUInt64LE(64) -
        big(cp.protocolFeesMintB) -
        big(cp.fundFeesMintB) -
        big(cp.creatorFeesMintB),
    };
  }

  /** Supply mint SPL (offset 36, u64) per mint; null jika akun tidak ada. */
  async mintSupplies(mints: string[]): Promise<Map<string, bigint | null>> {
    const out = new Map<string, bigint | null>();
    for (let i = 0; i < mints.length; i += 100) {
      const chunk = mints.slice(i, i + 100);
      const infos = await this.call(() =>
        this.connection.getMultipleAccountsInfo(
          chunk.map((m) => new PublicKey(m)),
          "confirmed",
        ),
      );
      chunk.forEach((m, j) => {
        const info = infos[j];
        out.set(m, info && info.data.length >= 44 ? info.data.readBigUInt64LE(36) : null);
      });
    }
    return out;
  }

  /**
   * Semua akun token untuk `mint`: owner + saldo. Program mengikuti mint (SPL klasik: akun 165
   * byte; Token-2022: ukuran bervariasi karena ekstensi, jadi hanya difilter mint di offset 0).
   */
  async tokenAccounts(mint: string): Promise<TokenAccountBalance[]> {
    const program = await this.call(() => mintProgramOf(this.connection, mint));
    const filters =
      program === TOKEN_PROGRAM
        ? [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }]
        : [{ memcmp: { offset: 0, bytes: mint } }];
    const accounts = await this.call(() =>
      this.connection.getProgramAccounts(new PublicKey(program), {
        commitment: "confirmed",
        dataSlice: { offset: 32, length: 40 },
        filters,
      }),
    );
    return accounts.map((a) => ({
      address: a.pubkey.toBase58(),
      owner: new PublicKey(a.account.data.subarray(0, 32)).toBase58(),
      amount: a.account.data.readBigUInt64LE(32),
    }));
  }

  /** Signature baru (paling baru dulu) sampai `until` (eksklusif), satu halaman. */
  async signatures(
    address: string,
    opts: { until?: string; before?: string; limit: number },
  ): Promise<SignatureInfo[]> {
    const list = await this.call(() =>
      this.connection.getSignaturesForAddress(
        new PublicKey(address),
        {
          limit: opts.limit,
          ...(opts.until ? { until: opts.until } : {}),
          ...(opts.before ? { before: opts.before } : {}),
        },
        "confirmed",
      ),
    );
    return list.map((s) => ({
      signature: s.signature,
      slot: s.slot,
      failed: s.err !== null,
      blockTime: s.blockTime ?? null,
    }));
  }

  /** null = belum tersedia di RPC (coba lagi nanti). */
  async transaction(signature: string): Promise<ParsedTradeTransaction | null> {
    const tx = await this.call(() => getTransactionAnyVersion(this.connection, signature));
    if (!tx) return null;
    return parseTradeTransaction(tx, signature, this.programs);
  }
}

/** Jumlah holder: owner unik dengan saldo > 0, tanpa vault pool (otoritas program). */
export function countHolders(
  accounts: TokenAccountBalance[],
  /** Otoritas program yang memegang vault pool (bukan holder sungguhan). */
  excludeOwners: Iterable<string>,
): number {
  const exclude = new Set(excludeOwners);
  const owners = new Set<string>();
  for (const a of accounts) if (a.amount > 0n && !exclude.has(a.owner)) owners.add(a.owner);
  return owners.size;
}

export interface LpDistribution {
  /** Total LP pool (lpAmount), termasuk yang dibakar. */
  total: bigint;
  /** lpAmount − supply mint LP = LP yang dibakar saat migrasi. */
  burned: bigint;
  /** Dipegang otoritas lock CPMM Raydium. */
  locked: bigint;
  /** Sisanya: LP bebas yang bisa ditarik pemegangnya. */
  free: bigint;
}

export function lpDistribution(
  lpAmount: bigint,
  lpMintSupply: bigint,
  lpAccounts: TokenAccountBalance[],
  /** Otoritas program lock LP CPMM Raydium (Burn & Earn), PoC Tahap 1 bagian (e). */
  lockAuthority: string,
): LpDistribution {
  const burned = lpAmount > lpMintSupply ? lpAmount - lpMintSupply : 0n;
  const locked = lpAccounts
    .filter((a) => a.owner === lockAuthority)
    .reduce((acc, a) => acc + a.amount, 0n);
  const free = lpMintSupply > locked ? lpMintSupply - locked : 0n;
  return { total: lpAmount, burned, locked, free };
}
