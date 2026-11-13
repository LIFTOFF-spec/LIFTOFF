/**
 * FEE_CONFIG — satu-satunya sumber angka fee LIFTOFF (Aturan #10), mengikuti Spec
 * (docs/SPEC_LIFT.md §9–10, Rule 2).
 *
 * Model Spec:
 *  - Sumber dana ekonomi LIFTOFF = CREATOR FEE yang diterima launch authority (master wallet,
 *    creator semua koin). Bukan platform fee.
 *  - Creator fee yang terverifikasi dialokasikan 80% Buyback & Burn / 20% Conviction Reserve
 *    per koin. Tidak ada porsi treasury: biaya operasional didanai pemilik proyek.
 *  - Platform fee milik StonkFun (platform yang konfigurasinya dipakai). Di devnet StonkFun
 *    diemulasikan oleh Platform PDA LIFTOFF (lihat stonkfun.ts); platform fee di sana tetap
 *    diperlakukan sebagai milik "StonkFun tiruan", BUKAN pendapatan LIFTOFF, dan tidak masuk
 *    alokasi 80/20.
 *
 * Batas program Raydium LaunchLab (devnet, program DRay6fNdQ5J82H7xV6uq2aV3mNrUZ1J4PgSKsWgptcm6,
 * terbukti Tahap 1):
 *  - platform fee ≤ 500 bps (feeRate ≤ 50_000 / 1_000_000) — di atasnya ditolak `InvalidInput`;
 *  - creator fee ≤ 50 bps (creatorFeeRate ≤ 5_000 / 1_000_000) — di atasnya `InvalidPlatformInfo`.
 * Creator fee curve masuk vault creator per (creator, quote mint) — agregat semua koin; atribusi
 * per koin diambil dari event program di transaksi trade (pool koin itu), lihat
 * apps/api/src/lib/creator-fee.ts.
 */

/** Basis point: 10_000 bps = 100%. */
export const BPS_DENOMINATOR = 10_000;

/** Batas yang ditegakkan program LaunchLab (terbukti di devnet, Tahap 1). */
export const LAUNCHLAB_MAX_PLATFORM_FEE_BPS = 500;
export const LAUNCHLAB_MAX_CREATOR_FEE_BPS = 50;

export type FeeConfigStatus = "unverified" | "verified";

/** Pembagian creator fee per koin (Spec Rule 2: tetap 80/20). Jumlahnya harus 10_000 bps. */
export interface FeeSplitBps {
  /** Porsi Buyback & Burn koin tersebut. */
  buybackBurn: number;
  /** Porsi Conviction Reserve koin tersebut. */
  convictionReserve: number;
}

/**
 * Ke mana sisa pembulatan alokasi integer pergi. Reserve dihitung floor; sisanya (termasuk
 * pecahan satuan terkecil) masuk Buyback & Burn, sehingga buyback + reserve = fee diterima
 * PERSIS (Spec §13: alokasi tidak pernah melebihi fee yang diterima, dan tidak ada sisa tak
 * bertuan karena tidak ada treasury).
 */
export type RoundingRemainderTarget = "buybackBurn";

export interface FeeConfig {
  status: FeeConfigStatus;
  /**
   * Platform fee curve (bps) di config platform yang dipakai. Milik StonkFun (devnet: StonkFun
   * tiruan = Platform PDA LIFTOFF). Maks LAUNCHLAB_MAX_PLATFORM_FEE_BPS.
   */
  platformFeeBps: number;
  /**
   * Creator fee curve (bps) → creator = master wallet LIFTOFF. Sumber dana 80/20.
   * Maks LAUNCHLAB_MAX_CREATOR_FEE_BPS.
   */
  creatorFeeBps: number;
  /**
   * Creator fee pool CPMM sesudah graduate (bps) yang DIHARAPKAN. Nilai ini milik config CPMM
   * Raydium (`cpConfigId` platform), bukan diatur LIFTOFF; quote selalu membaca rate on-chain dan
   * perbedaan diungkapkan di UI. Penerimanya `poolCreator` = master wallet (Tahap 5).
   */
  expectedCpmmCreatorFeeBps: number;
  /**
   * Referral (share fee) per trade dalam bps. Dimatikan (0): referral bukan bagian model Spec.
   * Dibatasi `maxShareFeeRate` global config LaunchLab per quote mint.
   */
  referralFeeBps: number;
  /** Pembagian creator fee per koin. */
  split: FeeSplitBps;
  roundingRemainderTo: RoundingRemainderTarget;
}

export const FEE_CONFIG: FeeConfig = {
  // Spec §9–10 + keputusan pemilik 2026-10-29 (docs/BUILD_PLAN.md, D-S2). Angka on-chain devnet
  // disinkronkan lewat `pnpm --filter @liftoff/signer platform-fee --send` (signature di plan).
  status: "verified",
  platformFeeBps: 100, // milik StonkFun (tiruan di devnet), bukan pendapatan LIFTOFF
  creatorFeeBps: 50, // maks LaunchLab; ke master wallet → 80/20
  expectedCpmmCreatorFeeBps: 25, // config CPMM devnet 5MxLgy9o… (dibaca on-chain saat quote)
  referralFeeBps: 0,
  split: {
    buybackBurn: 8_000, // Spec Rule 2: 80%
    convictionReserve: 2_000, // Spec Rule 2: 20%
  },
  roundingRemainderTo: "buybackBurn",
};

/** Memastikan config konsisten. Melempar error jika tidak valid. */
export function assertValidFeeConfig(config: FeeConfig): void {
  const { buybackBurn, convictionReserve } = config.split;
  const parts = [
    config.platformFeeBps,
    config.creatorFeeBps,
    config.expectedCpmmCreatorFeeBps,
    config.referralFeeBps,
    buybackBurn,
    convictionReserve,
  ];
  if (parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error("FEE_CONFIG: semua nilai bps harus bilangan bulat >= 0");
  }
  if (config.platformFeeBps > LAUNCHLAB_MAX_PLATFORM_FEE_BPS) {
    throw new Error(
      `FEE_CONFIG: platform fee maks ${LAUNCHLAB_MAX_PLATFORM_FEE_BPS} bps (batas LaunchLab)`,
    );
  }
  if (config.creatorFeeBps > LAUNCHLAB_MAX_CREATOR_FEE_BPS) {
    throw new Error(
      `FEE_CONFIG: creator fee maks ${LAUNCHLAB_MAX_CREATOR_FEE_BPS} bps (batas LaunchLab)`,
    );
  }
  if (
    config.referralFeeBps > BPS_DENOMINATOR ||
    config.expectedCpmmCreatorFeeBps > BPS_DENOMINATOR
  ) {
    throw new Error("FEE_CONFIG: fee tidak boleh melebihi 10_000 bps");
  }
  const total = buybackBurn + convictionReserve;
  if (total !== BPS_DENOMINATOR) {
    throw new Error(`FEE_CONFIG: total split harus ${BPS_DENOMINATOR} bps, didapat ${total}`);
  }
}

export interface CreatorFeeAllocation {
  buybackBurn: bigint;
  convictionReserve: bigint;
}

/**
 * Alokasi creator fee terverifikasi (satuan terkecil, integer) ke 80/20.
 *
 * Reserve = floor(amount × reserveBps / 10_000); Buyback & Burn = amount − reserve, jadi sisa
 * pembulatan (< 1 satuan terkecil × pecahan) selalu jatuh ke Buyback & Burn (`roundingRemainderTo`)
 * dan jumlah keduanya = amount persis. Contoh: 1 lamport → buyback 1, reserve 0; 9 lamport →
 * buyback 8, reserve 1 (1,8 dibulatkan ke bawah, sisa 0,8 ke buyback).
 */
export function allocateCreatorFee(
  amount: bigint,
  split: FeeSplitBps = FEE_CONFIG.split,
): CreatorFeeAllocation {
  if (amount < 0n) throw new Error("alokasi fee: amount negatif");
  if (split.buybackBurn + split.convictionReserve !== BPS_DENOMINATOR) {
    throw new Error("alokasi fee: split tidak berjumlah 10_000 bps");
  }
  const convictionReserve = (amount * BigInt(split.convictionReserve)) / BigInt(BPS_DENOMINATOR);
  return { buybackBurn: amount - convictionReserve, convictionReserve };
}
