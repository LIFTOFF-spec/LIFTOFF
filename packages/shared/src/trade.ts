/**
 * Trading di LIFTOFF (Tahap 5): tipe bersama API ↔ web, config, dan aturan fee.
 *
 * Pengguna menandatangani sendiri transaksi buy/sell dengan wallet-nya. API hanya membangun
 * transaksi UNSIGNED (fee payer = wallet pengguna) dan menyimulasikannya; master wallet dan
 * signer service tidak pernah dipakai untuk trade pengguna.
 *
 * Rute:
 *  - `launchlab` — bonding curve Raydium LaunchLab (sebelum graduate).
 *  - `cpmm`      — pool Raydium CPMM hasil migrasi (sesudah graduate). Satu-satunya rute
 *                  sesudah graduate di devnet: Jupiter tidak me-route token devnet (Tahap 1).
 *  - `jupiter`   — agregator Jupiter (sesudah graduate, mainnet). Ditolak di luar mainnet.
 */
import { z } from "zod";
import type { SolanaCluster } from "./cluster";
import { BPS_DENOMINATOR, FEE_CONFIG } from "./fee-config";

export const TRADE_ROUTES = ["launchlab", "cpmm", "jupiter"] as const;
export type TradeRoute = (typeof TRADE_ROUTES)[number];

/** Rute sesudah graduate yang bisa dipilih lewat config (TRADE_GRADUATED_ROUTE). */
export type GraduatedRoute = Extract<TradeRoute, "cpmm" | "jupiter">;

/** Satuan rate on-chain LaunchLab & CPMM: per 1_000_000. */
export const RAYDIUM_RATE_DENOMINATOR = 1_000_000;

/** Konversi bps (per 10_000) ↔ rate Raydium (per 1_000_000). */
export function bpsToRaydiumRate(bps: number): number {
  return (bps * RAYDIUM_RATE_DENOMINATOR) / BPS_DENOMINATOR;
}

export interface TradeConfig {
  defaultSlippageBps: number;
  /** Slippage maksimum yang diterima API (di atas ini hampir pasti salah ketik). */
  maxSlippageBps: number;
  graduatedRoute: GraduatedRoute;
  /** Batas compute unit transaksi trade (cukup untuk create ATA + wrap + swap + close). */
  computeUnitLimit: number;
  /** Priority fee (micro-lamport per CU). 0 di devnet. */
  computeUnitPriceMicroLamports: number;
}

export const TRADE_CONFIG: TradeConfig = {
  defaultSlippageBps: 100,
  maxSlippageBps: 5_000,
  graduatedRoute: "cpmm",
  computeUnitLimit: 300_000,
  computeUnitPriceMicroLamports: 0,
};

/** Jupiter hanya me-route token mainnet (Tahap 1: devnet → TOKEN_NOT_TRADABLE). */
export function assertGraduatedRouteAllowed(route: GraduatedRoute, cluster: SolanaCluster): void {
  if (route === "jupiter" && cluster !== "mainnet-beta") {
    throw new Error(
      `TRADE_GRADUATED_ROUTE=jupiter tidak tersedia di ${cluster} (Jupiter tidak me-route token devnet); pakai cpmm`,
    );
  }
}

/**
 * Referral (share fee) LaunchLab yang dipasang LIFTOFF pada trade lewat UI-nya: FEE_CONFIG
 * dikonversi ke satuan on-chain lalu dibatasi `maxShareFeeRate` global config quote mint.
 * Config dengan `maxShareFeeRate` 0 (mis. RAY devnet) → tanpa referral.
 */
export function referralShareRate(maxShareFeeRate: number, feeBps = FEE_CONFIG.referralFeeBps) {
  return Math.max(0, Math.min(bpsToRaydiumRate(feeBps), maxShareFeeRate));
}

// ---------------------------------------------------------------- request

const rawAmount = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/, "Amount must be a positive integer in base units.")
  // Zod tetap menjalankan refine setelah regex gagal, jadi BigInt hanya untuk string valid.
  .refine(
    (v) => !/^[0-9]+$/.test(v) || BigInt(v) <= 18_446_744_073_709_551_615n,
    "Amount is too large.",
  );

const pubkey = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "Invalid address.");

export const tradeQuoteRequestSchema = z.object({
  mint: pubkey,
  side: z.enum(["buy", "sell"]),
  /** Jumlah input dalam satuan terkecil: quote (lamport) untuk buy, token mentah untuk sell. */
  amountIn: rawAmount,
  slippageBps: z.number().int().min(1).max(TRADE_CONFIG.maxSlippageBps),
});
export type TradeQuoteRequest = z.infer<typeof tradeQuoteRequestSchema>;

export const tradeBuildRequestSchema = tradeQuoteRequestSchema.extend({
  /** Wallet pengguna = owner & fee payer transaksi. */
  wallet: pubkey,
});
export type TradeBuildRequest = z.infer<typeof tradeBuildRequestSchema>;

export const tradeConfirmRequestSchema = z.object({
  signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/, "Invalid signature."),
});

// ---------------------------------------------------------------- response

/**
 * Satu komponen fee yang dibayar pengguna. Semua nominal string satuan terkecil `mint`.
 * `rate` = rate on-chain per 1_000_000 (dibaca dari akun config/pool, bukan hardcode).
 */
export interface TradeFeeItem {
  kind: "platform" | "referral" | "raydium_protocol" | "raydium_lp" | "creator";
  label: string;
  rate: number;
  amount: string;
  mint: string;
  /** Penerima fee (untuk transparansi). */
  recipient: string | null;
}

export interface TradeQuote {
  route: TradeRoute;
  side: "buy" | "sell";
  mint: string;
  quoteMint: string;
  quoteSymbol: string;
  quoteDecimals: number;
  tokenDecimals: number;
  pool: string;
  /** Input yang benar-benar dipakai (bisa < diminta jika buy menghabiskan curve). */
  amountIn: string;
  amountInRequested: string;
  expectedOut: string;
  minOut: string;
  slippageBps: number;
  /** Fee per komponen; sesudah graduate fee CPMM bisa dalam mint token (sisi input). */
  fees: TradeFeeItem[];
  /** Dampak harga dibanding harga spot, bps. */
  priceImpactBps: number;
  /** Harga spot (quote per token, desimal). */
  spotPrice: string;
  curve: {
    /** 0 trading · 1 menunggu migrasi · 2 sudah migrasi (LaunchLab `status`). */
    status: number;
    progressPct: number;
    raisedQuote: string;
    targetQuote: string;
    /** Buy ini menghabiskan sisa curve (input dipotong). */
    completesCurve: boolean;
  } | null;
  /**
   * Fee on-chain (platform / creator curve, atau creator fee CPMM) berbeda dari FEE_CONFIG. Yang
   * ditampilkan & dipotong selalu angka on-chain; perbedaan ini wajib diungkapkan di UI.
   */
  feeConfigMismatch: Array<{
    kind: "platform" | "creator";
    configuredBps: number;
    onChainRate: number;
  }> | null;
  warnings: string[];
}

export interface TradeSimulation {
  ok: boolean;
  unitsConsumed: number | null;
  /** Kode error ramah pengguna (lihat TRADE_ERROR_CODES) bila simulasi gagal. */
  errorCode: TradeErrorCode | null;
  message: string | null;
}

export interface BuiltTrade {
  quote: TradeQuote;
  /** VersionedTransaction v0 base64, belum ditandatangani. Fee payer = wallet pengguna. */
  transaction: string;
  lastValidBlockHeight: number;
  simulation: TradeSimulation;
  /** Estimasi biaya jaringan + rent akun baru (lamport), di luar fee trade. */
  networkFeeLamports: string;
  rentLamports: string;
}

/** Fee yang benar-benar terpotong on-chain, dibaca dari event program di transaksi. */
export interface TradeReceipt {
  signature: string;
  route: TradeRoute;
  side: "buy" | "sell";
  mint: string;
  wallet: string;
  amountIn: string;
  amountOut: string;
  fees: TradeFeeItem[];
  slot: number;
  /**
   * Referral fee trade ini (null jika tidak ada referral). `pending` = belum dicatat API (Tahap 10
   * F4: API tidak menulis ledger ekonomi; lihat docs/SECURITY.md F4).
   */
  referralLedgerEntry: {
    amount: string;
    assetMint: string;
    recorded: "new" | "existing" | "pending";
  } | null;
  /**
   * Creator fee ke master wallet yang dicatat (Spec §9) beserta alokasi 80/20-nya, satuan terkecil
   * `assetMint`. null jika trade ini tidak membayar creator fee ke master wallet.
   */
  creatorFeeEntry: {
    amount: string;
    assetMint: string;
    buybackBurn: string;
    convictionReserve: string;
    /** `pending`: dari confirm API — ledger dicatat indexer dari transaksi on-chain yang sama. */
    recorded: "new" | "existing" | "pending";
  } | null;
}

export const TRADE_ERROR_CODES = [
  "insufficient_balance",
  "insufficient_token_balance",
  "slippage_exceeded",
  "curve_migrated",
  "curve_migrating",
  "pool_not_found",
  "amount_too_small",
  "route_unavailable",
  "token_not_tradable",
  "simulation_failed",
] as const;
export type TradeErrorCode = (typeof TRADE_ERROR_CODES)[number];
