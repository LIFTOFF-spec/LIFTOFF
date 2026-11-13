/**
 * RESERVE_CONFIG — parameter default Conviction Reserve (Spec §11–14, docs/SPEC_LIFT.md).
 *
 * Nilai inti mengikuti "Proposed Initial Parameters" Spec §12: threshold $250, maks 25% per
 * siklus, cooldown 24 jam, kondisi likuiditas, dan market safety checks. Spec menyebutnya
 * asumsi awal yang WAJIB divalidasi lewat simulasi & testing → status tetap `unverified`.
 * Bisa di-override per token (`reserve_config_overrides`); override hanya boleh lebih ketat.
 * UI wajib membaca angka dari sini, bukan menulis manual (Aturan #10).
 *
 * Tambahan di luar Spec (tidak bertentangan, ditandai `extra`, warisan v2): batas nominal per
 * run, porsi maksimum reserve di pool, jeda setelah graduation, batas global harian, backoff gagal.
 *
 * Reserve token yang belum graduate TIDAK pernah dipakai: tetap tersimpan sampai graduation +
 * pool terverifikasi (Spec §14, Rule 7). Opsi D (kedaluwarsa → buyback) dihapus (D5, Tahap 8).
 *
 * Reserve TIDAK mempertahankan harga/market cap tertentu (Spec §12 Critical Requirement, Rule 5).
 */

import { BPS_DENOMINATOR } from "./fee-config";

export type ReserveConfigStatus = "unverified" | "verified";

export interface ReserveConfig {
  status: ReserveConfigStatus;
  /** §12 Minimum Reserve Threshold: saldo reserve minimum (setara USD) sebelum boleh deploy. */
  minBalanceToDeployUsd: number;
  /** §12 Maximum Deployment Per Cycle: persentase maksimum saldo per deployment, bps. */
  maxDeployPctPerRunBps: number;
  /** §12 Cooldown: jeda minimal antar deployment per token. */
  cooldownSeconds: number;
  /**
   * §12 Liquidity Condition: deploy hanya dipertimbangkan jika kedalaman likuiditas pool yang
   * terukur (setara USD, sisi quote) DI BAWAH ambang ini.
   */
  deployWhenLiquidityBelowUsd: number;
  /** Batas dampak harga transaksi deploy (bagian dari "no abnormal pool state"). */
  maxPriceImpactBps: number;
  maxSlippageBps: number;
  /** Umur maksimum data harga agar dianggap "reliable" (§12 Price data is reliable). */
  maxPriceAgeSeconds: number;
  /** Lonjakan harga/likuiditas 1 jam yang dianggap abnormal (bps). */
  abnormalMoveBps: number;
  // ------------------------------------------------------------ extra (di luar Spec)
  /** extra: batas nominal per deployment (setara USD). */
  maxDeployAbsPerRunUsd: number;
  /** extra: porsi maksimum reserve terhadap pool setelah deploy, bps. */
  maxReserveShareOfPoolBps: number;
  /** extra: jeda setelah graduation sebelum deploy pertama. */
  minTimeSinceGraduationSeconds: number;
  /** extra: maksimum deployment per jendela waktu, per token. */
  maxDeploysPerWindow: number;
  deployWindowSeconds: number;
  /** extra: batas deployment harian untuk seluruh platform. */
  globalMaxDeploysPerDay: number;
  /** extra: cooldown tambahan setelah deployment gagal / kondisi pasar ekstrem. */
  failureBackoffSeconds: number;
}

export const RESERVE_CONFIG: ReserveConfig = {
  status: "unverified", // Spec §12: asumsi awal, validasi lewat simulasi (Phase 3)
  minBalanceToDeployUsd: 250, // Spec §12
  maxDeployPctPerRunBps: 2_500, // Spec §12: 25%
  cooldownSeconds: 24 * 60 * 60, // Spec §12: 24 jam
  deployWhenLiquidityBelowUsd: 50_000, // asumsi awal, belum diverifikasi
  maxPriceImpactBps: 150, // asumsi awal
  maxSlippageBps: 100, // asumsi awal
  maxPriceAgeSeconds: 120, // asumsi awal
  abnormalMoveBps: 3_000, // asumsi awal: ±30% dalam 1 jam
  maxDeployAbsPerRunUsd: 5_000, // extra
  maxReserveShareOfPoolBps: 2_000, // extra
  minTimeSinceGraduationSeconds: 24 * 60 * 60, // extra
  maxDeploysPerWindow: 1, // extra; konsisten dengan cooldown 24 jam
  deployWindowSeconds: 24 * 60 * 60, // extra
  globalMaxDeploysPerDay: 50, // extra
  failureBackoffSeconds: 12 * 60 * 60, // extra
};

/** Nama parameter yang berasal langsung dari Spec §12 (sisanya tambahan LIFTOFF). */
export const SPEC_RESERVE_KEYS = [
  "minBalanceToDeployUsd",
  "maxDeployPctPerRunBps",
  "cooldownSeconds",
  "deployWhenLiquidityBelowUsd",
] as const satisfies readonly (keyof ReserveConfig)[];

/** Memastikan config konsisten. Melempar error jika tidak valid. */
export function assertValidReserveConfig(config: ReserveConfig): void {
  for (const [key, value] of Object.entries(config)) {
    if (key === "status") continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new Error(`RESERVE_CONFIG: ${key} harus bilangan bulat >= 0`);
    }
  }
  const bpsKeys = [
    "maxDeployPctPerRunBps",
    "maxReserveShareOfPoolBps",
    "maxSlippageBps",
    "maxPriceImpactBps",
  ] as const;
  for (const key of bpsKeys) {
    if (config[key] > BPS_DENOMINATOR) {
      throw new Error(`RESERVE_CONFIG: ${key} tidak boleh melebihi ${BPS_DENOMINATOR} bps`);
    }
  }
}

// ---------------------------------------------------------------- evaluasi deployment (§12)

/** Market Safety Checks Spec §12 (urutan sama dengan Spec). */
export const RESERVE_SAFETY_CHECKS = [
  "pool_active",
  "token_graduated",
  "swap_route_available",
  "reserve_sufficient",
  "price_data_reliable",
  "pool_state_normal",
] as const;
export type ReserveSafetyCheck = (typeof RESERVE_SAFETY_CHECKS)[number];

export interface ReserveDeploymentInput {
  nowSeconds: number;
  /** Pool hasil graduation terverifikasi (§14) dan aktif. */
  poolActive: boolean;
  graduated: boolean;
  /** Mekanisme add-liquidity pool terverifikasi kompatibel (§14, Rule 7). */
  poolCompatible: boolean;
  swapRouteAvailable: boolean;
  /** Saldo reserve koin INI (bukan koin lain, Spec §11) setara USD. null = tanpa harga terverifikasi. */
  reserveBalanceUsd: number | null;
  /** Kedalaman likuiditas pool terukur (setara USD). null = tanpa harga terverifikasi. */
  poolLiquidityUsd: number | null;
  /** Umur data harga (detik); null = tidak ada harga. */
  priceAgeSeconds: number | null;
  /** Perubahan harga/likuiditas absolut 1 jam terakhir (bps). */
  oneHourMoveBps: number;
  /** Dampak harga simulasi transaksi deploy (bps). */
  simulatedPriceImpactBps: number;
  lastDeployAtSeconds: number | null;
  graduatedAtSeconds: number | null;
  paused: boolean;
}

export interface ReserveDeploymentDecision {
  allowed: boolean;
  /** Jumlah maksimum yang boleh dideploy siklus ini (setara USD), 0 jika tidak boleh. */
  maxDeployUsd: number;
  failedSafetyChecks: ReserveSafetyCheck[];
  /** Alasan yang bisa dibaca pengguna (ditampilkan di halaman reserve). */
  reasons: string[];
}

/**
 * Aturan deployment Spec §12 (fungsi murni). Engine Phase 3 menyimpan hasilnya di
 * `reserve_decisions` (append-only). Tidak pernah mencoba mempertahankan harga tertentu.
 */
export function evaluateReserveDeployment(
  input: ReserveDeploymentInput,
  config: ReserveConfig = RESERVE_CONFIG,
): ReserveDeploymentDecision {
  const reasons: string[] = [];
  const failed: ReserveSafetyCheck[] = [];
  const fail = (check: ReserveSafetyCheck, why: string) => {
    failed.push(check);
    reasons.push(why);
  };

  if (input.paused) reasons.push("Reserve deployment is paused by the operator.");
  if (!input.poolActive) fail("pool_active", "The pool is not active.");
  if (!input.graduated) fail("token_graduated", "The token has not graduated yet.");
  if (!input.poolCompatible) {
    reasons.push("The graduated pool is not verified for reserve liquidity operations yet.");
  }
  if (!input.swapRouteAvailable) fail("swap_route_available", "No swap route is available.");
  if (input.reserveBalanceUsd === null) {
    fail(
      "reserve_sufficient",
      `Whether the reserve meets the $${config.minBalanceToDeployUsd} minimum is unknown without a verified price.`,
    );
  } else if (input.reserveBalanceUsd < config.minBalanceToDeployUsd) {
    fail(
      "reserve_sufficient",
      `Reserve is below the $${config.minBalanceToDeployUsd} minimum threshold.`,
    );
  }
  if (input.priceAgeSeconds === null || input.priceAgeSeconds > config.maxPriceAgeSeconds) {
    fail("price_data_reliable", "Price data is missing or stale.");
  }
  if (
    input.oneHourMoveBps > config.abnormalMoveBps ||
    input.simulatedPriceImpactBps > config.maxPriceImpactBps
  ) {
    fail("pool_state_normal", "Abnormal pool state detected; waiting for conditions to normalize.");
  }
  if (
    input.poolLiquidityUsd !== null &&
    input.poolLiquidityUsd >= config.deployWhenLiquidityBelowUsd
  ) {
    reasons.push(
      `Pool liquidity is above the $${config.deployWhenLiquidityBelowUsd} reinforcement threshold.`,
    );
  }
  if (
    input.lastDeployAtSeconds !== null &&
    input.nowSeconds - input.lastDeployAtSeconds < config.cooldownSeconds
  ) {
    reasons.push(`Cooldown: at most one deployment every ${config.cooldownSeconds / 3600} hours.`);
  }
  if (
    input.graduatedAtSeconds !== null &&
    input.nowSeconds - input.graduatedAtSeconds < config.minTimeSinceGraduationSeconds
  ) {
    reasons.push("Waiting period after graduation has not passed yet.");
  }

  const allowed = reasons.length === 0;
  const pctCap = ((input.reserveBalanceUsd ?? 0) * config.maxDeployPctPerRunBps) / BPS_DENOMINATOR;
  return {
    allowed,
    maxDeployUsd: allowed ? Math.min(pctCap, config.maxDeployAbsPerRunUsd) : 0,
    failedSafetyChecks: failed,
    reasons,
  };
}

// ---------------------------------------------------------------- worker reserve (Tahap 8)

/**
 * Parameter operasional Conviction Reserve Worker (bukan aturan deployment Spec §12).
 * Pemindahan reserve ke akun kustodi token dibatch: transfer 5.000 lamport + rent akun kustodi
 * 2.039.280 lamport sekali per token (dibayar SOL operasional master, bukan dana reserve).
 */
export const RESERVE_WORKER_CONFIG = {
  intervalMs: 15 * 60_000,
  minFundRaw: { So11111111111111111111111111111111111111112: "10000000", default: "1000000" },
} as const;
