/**
 * Parameter anti-copycat (Spec §7), batas launch, dan syarat wallet (Tahap 3, D9 revisi).
 *
 * Transaksi launch tetap ditandatangani & dibayar launch authority = master wallet (Spec §5), tetapi
 * sejak keputusan pemilik 2026-10-31 creator mengganti biaya itu lewat deposit launch
 * (`LAUNCH_DEPOSIT`). Batas harian global dan kuota per wallet tetap sebagai pelindung.
 * Semua nilai bisa ditimpa lewat env di apps/api.
 */
import type { RiskIndicatorCode } from "./copycat";

export interface AntiCopycatConfig {
  /** Jarak Hamming pHash maksimum (inklusif) yang dianggap gambar salinan. 0–64. */
  imageHashMaxDistance: number;
  /**
   * Likuiditas USD minimum agar ticker yang sudah diperdagangkan di luar dianggap "nyata"
   * dan ditolak. Token dengan likuiditas di bawah ini tidak memblokir ticker.
   */
  externalMinLiquidityUsd: number;
  /** Batas waktu request ke sumber data pasar publik. */
  externalLookupTimeoutMs: number;
  /**
   * Perilaku jika sumber data pasar tidak bisa dihubungi.
   *  - `reject`: tolak launch dengan alasan yang jelas (aman: tidak ada copycat yang lolos).
   *  - `allow_with_warning`: izinkan, catat peringatan (untuk devnet / development).
   */
  externalUnavailablePolicy: "reject" | "allow_with_warning";
  /** Kemiripan nama (0–1, Levenshtein ternormalisasi) yang dihitung sebagai "nama mirip". */
  nameSimilarityThreshold: number;
  /** Bobot tiap indikator Spec §7. */
  riskWeights: Record<RiskIndicatorCode, number>;
  /** Skor minimum untuk High (diblok otomatis, bisa banding). 0 < skor < ini → Medium. */
  highRiskScore: number;
}

export const ANTI_COPYCAT_CONFIG: AntiCopycatConfig = {
  imageHashMaxDistance: 10,
  externalMinLiquidityUsd: 10_000,
  externalLookupTimeoutMs: 4_000,
  externalUnavailablePolicy: "reject",
  nameSimilarityThreshold: 0.85,
  riskWeights: {
    name_identical: 1,
    name_similar: 1,
    ticker_repeated: 1,
    ticker_external: 1,
    image_similar: 1,
    // Memakai akun X / website / Telegram token lain = peniruan langsung → High sendiri.
    social_x_reused: 2,
    social_website_reused: 2,
    social_telegram_reused: 2,
  },
  highRiskScore: 2,
};

export interface LaunchLimitsConfig {
  /** Maksimum launch job baru per hari (UTC) untuk seluruh platform. */
  globalPerDay: number;
  /** Maksimum launch job per wallet dalam 24 jam bergulir, tanpa akun X tertaut. */
  perWalletPer24h: number;
  /** Idem, jika wallet menautkan akun X (verified creator). */
  perWalletWithXPer24h: number;
}

/**
 * Batas launch (D9 revisi): identitas = wallet (SIWS), akun X opsional. Satu akun X tertaut
 * tetap hanya boleh punya satu koin aktif, jadi kuota "dengan X" baru terpakai penuh jika
 * koin sebelumnya gagal/tidak aktif.
 */
export const LAUNCH_LIMITS: LaunchLimitsConfig = {
  globalPerDay: 200,
  perWalletPer24h: 1,
  perWalletWithXPer24h: 3,
};

/**
 * Syarat minimum wallet untuk launch (anti-spam). Saldo hanya DICEK lewat RPC, tidak dipotong.
 * Dicek lagi saat POST /api/launch, yaitu SETELAH deposit launch terkirim — jadi creator butuh
 * saldo minimum + deposit + fee jaringan (web memeriksanya sebelum meminta transfer).
 * 0 = syarat tidak dipakai.
 */
export interface WalletRequirementsConfig {
  /** Saldo SOL minimum (lamport). Default 0,05 SOL. */
  minBalanceLamports: number;
  /** Umur wallet minimum (hari sejak transaksi pertama). Default 0 = mati (wallet devnet baru). */
  minAgeDays: number;
}

export const WALLET_REQUIREMENTS: WalletRequirementsConfig = {
  minBalanceLamports: 50_000_000,
  minAgeDays: 0,
};

/**
 * Deposit launch = biaya launch yang dibayar creator (keputusan pemilik 2026-10-31, BUILD_PLAN §8).
 * Creator mentransfer SOL ke master wallet dari wallet-nya sendiri sebelum launch; master wallet
 * tetap yang menandatangani & membayar transaksi create. Deposit DISIMPAN jika launch live dan
 * DIKEMBALIKAN otomatis hanya jika launch gagal permanen.
 */
export interface LaunchDepositConfig {
  enabled: boolean;
  /**
   * Biaya launch nyata master wallet per koin. Devnet, Token-2022 (`initialize_with_token2022`),
   * terukur (rent mint + metadata + pool + vault, fee 2 signature; BUILD_PLAN §7f): 8.427.560
   * lamport (skrip PoC) dan 8.595.200 lamport (launch produksi lewat worker; metadata lebih
   * panjang). Dibulatkan ke 0,009 SOL agar variasi panjang metadata tertutup. StonkFun mainnet
   * ±0,012 SOL — WAJIB diukur ulang di Tahap 10 lalu ditimpa lewat LAUNCH_DEPOSIT_LAMPORTS.
   */
  lamports: number;
}

export const LAUNCH_DEPOSIT: LaunchDepositConfig = {
  enabled: true,
  lamports: 9_000_000,
};

export interface RateLimitRule {
  /** Jumlah request maksimum per jendela. */
  max: number;
  windowSeconds: number;
}

/** Rate limit per IP, per user, dan per wallet (fixed window di Redis). */
export const RATE_LIMITS = {
  /** Semua request API per IP. */
  ipGlobal: { max: 300, windowSeconds: 60 },
  /** POST /api/launch/validate per IP / akun X / wallet. */
  validate: { max: 30, windowSeconds: 60 },
  /** GET /api/pairs/:id per IP: tiap mint baru memakai satu request pricing StonkFun. */
  pairDetail: { max: 30, windowSeconds: 60 },
  /** POST /api/launch per IP / akun X / wallet. */
  launch: { max: 5, windowSeconds: 60 * 60 },
  /** Upload gambar per IP / akun X. */
  upload: { max: 20, windowSeconds: 60 * 60 },
  /** Login (SIWS / OAuth X / dev) per IP. */
  auth: { max: 20, windowSeconds: 60 },
  /** POST /api/trade/* (quote, build, confirm) per IP / wallet. Quote dipanggil saat mengetik. */
  trade: { max: 120, windowSeconds: 60 },
} satisfies Record<string, RateLimitRule>;
