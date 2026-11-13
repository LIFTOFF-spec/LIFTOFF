/**
 * Konfigurasi launch engine & signer service (Tahap 4). Nilai bisa ditimpa lewat env di
 * apps/worker dan apps/signer. Biaya launch terukur di Tahap 1: 0,020617 SOL per koin.
 */
import type { PerQuoteRaw } from "./economic-config";

export const LAUNCH_QUEUE = "launch";

/**
 * Jalur pengiriman transaksi.
 *  - `rpc`: sendRawTransaction ke RPC biasa. Satu-satunya jalur di devnet (Jito tidak ada di
 *    devnet, docs/poc-report.md bagian d). BUKAN private bundle.
 *  - `jito`: bundle Jito dengan tip. Hanya mainnet, diuji baru di Tahap 10.
 */
export type LaunchSendMode = "rpc" | "jito";

export interface LaunchEngineConfig {
  sendMode: LaunchSendMode;
  /** Berapa kali transaksi create boleh dibangun ulang (mint keypair yang sama) sebelum failed. */
  maxSubmissions: number;
  /** Jeda polling konfirmasi signature. */
  confirmPollMs: number;
  /** Lama satu run processor menunggu konfirmasi sebelum menjadwal ulang dirinya. */
  confirmWaitMs: number;
  /** Jeda sebelum mencoba lagi saat signer dipause. */
  pausedRetryMs: number;
  /** Interval sweeper yang mengambil ulang job macet (worker restart, enqueue gagal). */
  sweepIntervalMs: number;
  /** Job non-final yang tidak berubah selama ini dianggap macet oleh sweeper. */
  staleAfterMs: number;
  /** Percobaan BullMQ per run sebelum job ditandai needs_reconciliation. */
  queueAttempts: number;
  /** Tip Jito per bundle (lamport). Hanya untuk sendMode `jito`. */
  jitoTipLamports: number;
}

export const LAUNCH_ENGINE: LaunchEngineConfig = {
  sendMode: "rpc",
  maxSubmissions: 3,
  confirmPollMs: 2_000,
  confirmWaitMs: 45_000,
  pausedRetryMs: 30_000,
  sweepIntervalMs: 30_000,
  staleAfterMs: 60_000,
  queueAttempts: 8,
  jitoTipLamports: 1_000_000,
};

/** Tujuan permintaan tanda tangan; tiap tujuan punya allowlist instruksinya sendiri. */
export type SignPurpose = "launch" | "deposit_refund" | EconomicSignPurpose;

/** Tujuan economic engine (Tahap 7): selalu merujuk satu baris economic_ops (opId). */
export type EconomicSignPurpose =
  "fee_claim" | "buyback" | "burn" | "reserve_fund" | "reserve_deploy";

export interface SignerPolicyConfig {
  /** Pengeluaran SOL maksimum master wallet per transaksi (fee + rent + transfer), lamport. */
  maxLamportsPerTx: number;
  /** Pengeluaran SOL maksimum master wallet per 24 jam bergulir, lamport. */
  maxLamportsPer24h: number;
  /** Jumlah transaksi maksimum yang ditandatangani per 24 jam bergulir. */
  maxTxPer24h: number;
  /**
   * Pengeluaran SOL maksimum per transaksi economic engine (claim/buyback/burn): fee jaringan +
   * rent ATA baru. Dana buyback berasal dari akun quote (WSOL), bukan SOL native, jadi tidak
   * masuk hitungan ini; budgetnya dicek signer langsung dari ledger.
   */
  maxLamportsPerEconomicTx: number;
  /**
   * F2 (Tahap 10): signer membaca state pool sendiri dan menolak buyback bila
   * `minOut < quote signer × (1 − bps)`. Lebih longgar dari slippage worker (ECONOMIC_CONFIG
   * 300 bps) supaya pergerakan harga beberapa detik antara quote worker dan tanda tangan tidak
   * menolak buyback sah; tetap menutup minOut yang sengaja dilonggarkan (sandwich).
   */
  maxBuybackSlippageBps: number;
  /** F2: sama untuk reserve_deploy (swapMinOut, LP vs batas deposit). Worker = 100 bps. */
  maxReserveSlippageBps: number;
  /**
   * F3: batas absolut aset yang keluar dari akun token milik master (ATA + kustodi reserve) per
   * 24 jam bergulir, satuan terkecil per mint (`default` untuk mint lain, termasuk token LIFTOFF).
   * Diukur dari simulasi (saldo sebelum − sesudah), bukan dari baris DB.
   */
  maxAssetOutflowRawPer24h: PerQuoteRaw;
  /**
   * F8: aksi dengan keluaran aset ≥ nilai ini (per mint, `default`) dicek silang di RPC cadangan
   * (saldo + state pool) sebelum ditandatangani. Tanpa RPC cadangan dilewati (dicatat di audit).
   */
  crossCheckMinRaw: PerQuoteRaw;
  /** F8: selisih quote pool maksimum antar RPC sebelum ditolak (bps). */
  crossCheckToleranceBps: number;
}

/**
 * Batas signer. Launch = ±0,0206 SOL, jadi 0,03 SOL per transaksi memberi ruang untuk fee/
 * priority fee tetapi menolak transaksi yang menguras treasury. Batas harian ≈ LAUNCH_LIMITS
 * global (200/hari) × biaya launch, dibulatkan.
 */
export const SIGNER_POLICY: SignerPolicyConfig = {
  maxLamportsPerTx: 30_000_000,
  maxLamportsPer24h: 5_000_000_000,
  maxTxPer24h: 400,
  maxLamportsPerEconomicTx: 3_000_000,
  maxBuybackSlippageBps: 500,
  maxReserveSlippageBps: 300,
  // WSOL: 10 SOL/hari (buyback per tx maks 1 SOL). Quote lain: setara lewat skala raise (`perQuote`).
  // Token LIFTOFF (6 desimal): 100 juta unit tampilan ≈ 10% suplai 1 miliar. Mainnet: tetapkan lewat env.
  maxAssetOutflowRawPer24h: {
    So11111111111111111111111111111111111111112: "10000000000",
    default: "100000000000000",
  },
  // 0,1 SOL; quote lain setara lewat skala raise; token LIFTOFF 100 unit tampilan (6 desimal).
  crossCheckMinRaw: {
    So11111111111111111111111111111111111111112: "100000000",
    default: "100000000",
  },
  crossCheckToleranceBps: 100,
};

/** Biaya launch terukur di devnet (Tahap 1), untuk estimasi & alert saldo. */
export const LAUNCH_COST_LAMPORTS = 20_617_000;
