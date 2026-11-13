/** Port economic engine (implementasi nyata di rpc-chain.ts, palsu di fakes.ts). */
import type { EconomicConfig, FeeIntakeMode, PairConfig } from "@liftoff/shared";
import type { CpmmClaimable } from "@liftoff/solana/economic";
import type {
  ReserveDeployPlan,
  ReservePoolMetrics,
  ReserveVaultAddresses,
} from "@liftoff/solana/reserve";
import type { BuiltTx, SignatureStatus } from "../launch/ports";

export interface PreparedBuyback {
  route: "launchlab" | "cpmm";
  /** Quote yang benar-benar dibelanjakan (curve hampir penuh → bisa < diminta). */
  amountIn: bigint;
  expectedOut: bigint;
  /** expectedOut × (1 − slippage): dicek program on-chain. */
  minOut: bigint;
  priceImpactBps: number;
}

export type BuybackPreparation =
  { ok: true; buyback: PreparedBuyback } | { ok: false; reason: string };

/** Kredit masuk ke satu akun token (deteksi fee yang diteruskan StonkFun). */
export interface InboundCredit {
  signature: string;
  slot: number;
  failed: boolean;
  mint: string;
  /** Δ saldo akun (positif = masuk). */
  amount: bigint;
  signers: string[];
  /** Owner akun token yang saldonya turun untuk mint yang sama (pengirim). */
  sourceOwners: string[];
  /** Program yang dipanggil transaksi (termasuk inner instruction). */
  programs: string[];
}

export interface LandedTx {
  slot: number;
  failed: boolean;
  tokenDeltas: Array<{ account: string; owner: string | null; mint: string; delta: bigint }>;
}

export interface EconomicChain {
  masterLamports(): Promise<bigint>;
  /** ATA master untuk mint ini, di program token milik mint (SPL klasik / Token-2022). */
  masterTokenAccount(mint: string): Promise<string>;
  /** Akun kustodi reserve token ini (alamat ikut program token quote & token). */
  reserveVault(tokenMint: string, quoteMint: string): Promise<ReserveVaultAddresses>;
  tokenBalance(account: string): Promise<bigint>;
  curveClaimable(quoteMint: string): Promise<{ vault: string; amount: bigint }>;
  cpmmClaimable(pool: string): Promise<CpmmClaimable | null>;
  prepareBuyback(p: {
    mint: string;
    pair: PairConfig;
    amountIn: bigint;
    slippageBps: number;
  }): Promise<BuybackPreparation>;
  buildClaimCurve(quoteMint: string): Promise<BuiltTx>;
  buildClaimCpmm(pool: string): Promise<BuiltTx>;
  buildBuyback(p: {
    mint: string;
    pair: PairConfig;
    amountIn: bigint;
    minOut: bigint;
  }): Promise<BuiltTx>;
  buildBurn(p: { mint: string; amount: bigint; closeAccount: boolean }): Promise<BuiltTx>;
  signatureStatuses(signatures: string[]): Promise<Array<SignatureStatus | null>>;
  blockHeight(): Promise<number>;
  landedTx(signature: string): Promise<LandedTx | null>;
  /**
   * Transaksi yang menyentuh `account` setelah `until` (eksklusif), terlama dulu, maks `limit`;
   * kredit masuk per transaksi. `newest` = signature terbaru yang terbaca (kursor berikutnya).
   */
  inboundCredits(
    account: string,
    opts: { until: string | null; limit: number },
  ): Promise<{ credits: InboundCredit[]; newest: string | null }>;
  /**
   * SOL biasa yang masuk ke `wallet` setelah `until`, terlama dulu; `mint` kredit = WSOL.
   * `cursor` = signature terakhir yang sudah terbaca, tidak melewati transaksi yang belum tersedia.
   */
  inboundNativeCredits(
    wallet: string,
    opts: { until: string | null },
  ): Promise<{ credits: InboundCredit[]; cursor: string | null }>;

  // ---- Conviction Reserve (Tahap 8)
  accountExists(address: string): Promise<boolean>;
  /** State pool CPMM hasil migrasi token (liquidity monitoring); null bila belum ada. */
  reservePool(p: { mint: string; pair: PairConfig }): Promise<ReservePoolMetrics | null>;
  prepareReserveDeploy(p: {
    mint: string;
    pair: PairConfig;
    deployQuote: bigint;
    slippageBps: number;
  }): Promise<ReserveDeployPreparation>;
  buildReserveFund(p: {
    tokenMint: string;
    quoteMint: string;
    amount: bigint;
    createAccount: boolean;
  }): Promise<BuiltTx>;
  buildReserveDeploy(p: {
    tokenMint: string;
    pair: PairConfig;
    plan: ReserveDeployPlanFields;
    createTokenAccount: boolean;
    closeLpAccount: boolean;
  }): Promise<BuiltTx>;
  /** Bukti on-chain deployment: token hasil swap & LP yang dibakar di transaksi itu. */
  inspectReserveDeploy(
    signature: string,
    p: { lpMint: string; lpAccount: string; pool: string },
  ): Promise<ReserveDeployProof | null>;
}

export type ReserveDeployPlanFields = Pick<
  ReserveDeployPlan,
  "swapIn" | "swapMinOut" | "lpAmount" | "maxQuote" | "maxToken"
>;

export type ReserveDeployPreparation =
  { ok: true; plan: ReserveDeployPlan } | { ok: false; reason: string };

export interface ReserveDeployProof {
  failed: boolean;
  /** Output SwapEvent CPMM di pool token itu. */
  tokenBought: bigint | null;
  /** Jumlah LP pada instruksi SPL Burn (mint LP pool, dari ATA LP master). */
  lpBurned: bigint;
  /** Saldo ATA LP master sesudahnya (0 / ditutup = tidak ada LP bebas tersisa). */
  lpLeft: bigint;
}

export interface EconomicWorkerSettings extends EconomicConfig {
  /** Jalur buyback token yang sudah graduate: `cpmm` (devnet) | `jupiter` (mainnet, Tahap 10). */
  graduatedRoute: "cpmm" | "jupiter";
  /** Cara creator fee masuk (dari StonkFunAdapter.feeIntake): `claim` | `forwarded`. */
  feeIntake: FeeIntakeMode;
  /** Wallet forwarder StonkFun yang dikenal (strategi `forwarded`). */
  forwarders: string[];
  /** Mati: fee tetap dicatat, tetapi buyback & Conviction Reserve tidak membelanjakannya. */
  feeSpendingEnabled: boolean;
  /** Lama menunggu konfirmasi di dalam satu siklus sebelum diserahkan ke siklus berikutnya. */
  confirmWaitMs: number;
  confirmPollMs: number;
}

export interface EconomicLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}
