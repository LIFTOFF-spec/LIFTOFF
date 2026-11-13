/**
 * ECONOMIC_CONFIG — parameter economic engine (Tahap 7, Spec §9, §13, §20A–B, Requirement 9).
 *
 * Alur: creator fee di-claim master wallet (vault creator LaunchLab per quote mint / creator fee
 * pool CPMM per token) → direkonsiliasi dengan alokasi ledger per token → 80% buyback token itu
 * sendiri → semua hasil buyback dibakar. 20% Conviction Reserve tetap tercatat per token (dana
 * fisiknya tetap di akun quote master wallet sampai Tahap 8).
 *
 * Dana ekonomi disimpan sebagai token quote (WSOL untuk pair SOL) di ATA master wallet, terpisah
 * dari SOL native yang dipakai untuk biaya operasional. Saldo per token = ledger, bukan saldo ATA.
 *
 * Biaya nyata devnet (terukur Tahap 1 & 7, lihat docs/BUILD_PLAN.md Tahap 7):
 *  - claim (vault creator / pool CPMM): 1 tanda tangan = 5.000 lamport (ATA quote sudah ada);
 *  - buyback curve / CPMM: 5.000 lamport + rent ATA token 2.039.280 lamport yang dikembalikan
 *    saat ATA ditutup di transaksi burn (bila saldo ATA habis);
 *  - burn: 5.000 lamport;
 *  - fee swap ikut terpotong dari budget: curve 1% platform (StonkFun) + 0,25% protocol + 0,5%
 *    creator (kembali ke LIFTOFF lewat claim berikutnya); CPMM 0,25% pool + 0,25% creator.
 * Biaya jaringan per siklus ≈ 15.000 lamport. Threshold minimum 0,01 SOL membuat biaya jaringan
 * ≤ 0,15% dari nilai buyback (Spec §9 "Important": tidak ada swap tak ekonomis).
 */

export interface PerQuoteRaw {
  /** Nilai per quote mint (satuan terkecil, string desimal). `default` untuk mint lain. */
  [quoteMint: string]: string;
}

export interface EconomicConfig {
  /** Interval worker fee-processing (claim + rekonsiliasi). */
  claimIntervalMs: number;
  /** Claim hanya bila saldo yang bisa di-claim ≥ nilai ini (biaya claim 5.000 lamport). */
  minClaimRaw: PerQuoteRaw;
  /**
   * Rekonsiliasi menunggu indexer mencatat semua trade sampai slot claim. Setelah batas ini, selisih
   * dicatat sebagai `estimated` + entri `correction` (Spec §13).
   */
  reconcileGraceMs: number;
  /** Interval worker buyback + burn. */
  buybackIntervalMs: number;
  /** Budget buyback minimum per token sebelum dieksekusi (batching, Spec §9 "Important"). */
  minBuybackRaw: PerQuoteRaw;
  /** Batas satu buyback; budget lebih besar dieksekusi bertahap. */
  maxBuybackRawPerTx: PerQuoteRaw;
  /** Batas slippage (minOut = quote × (1 − slippage)). */
  slippageBps: number;
  /** Buyback ditunda bila dampak harga quote melebihi batas ini. */
  maxPriceImpactBps: number;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
  /** Percobaan maksimum per target sebelum berhenti dan memicu alert. */
  maxAttemptsPerTarget: number;
  /** Jeda sebelum mencoba lagi setelah operasi gagal. */
  retryBackoffMs: number;
  /** Alert saldo SOL master wallet rendah (lamport). */
  lowMasterBalanceLamports: string;
  /** Alert bila worker gagal berturut-turut sebanyak ini. */
  alertConsecutiveFailures: number;
}

const SOL_MINT = "So11111111111111111111111111111111111111112";

export const ECONOMIC_CONFIG: EconomicConfig = {
  claimIntervalMs: 10 * 60_000,
  minClaimRaw: { [SOL_MINT]: "1000000", default: "1" },
  reconcileGraceMs: 15 * 60_000,
  buybackIntervalMs: 5 * 60_000,
  // 0,01 SOL (lihat perhitungan biaya di atas). Pair non-SOL: setara lewat skala raise (`perQuote`).
  minBuybackRaw: { [SOL_MINT]: "10000000", default: "1000000" },
  maxBuybackRawPerTx: { [SOL_MINT]: "1000000000", default: "1000000000000" },
  slippageBps: 300,
  maxPriceImpactBps: 1_000,
  computeUnitLimit: 300_000,
  computeUnitPriceMicroLamports: 0,
  maxAttemptsPerTarget: 5,
  retryBackoffMs: 5 * 60_000,
  lowMasterBalanceLamports: "200000000",
  alertConsecutiveFailures: 3,
};

/**
 * Raise default StonkFun untuk pair SOL. StonkFun menyetarakan raise pair lain dengan nilai ini
 * (`raise.basis`: "worth the same as the default 85 SOL raise"), dan preflight mengecek nilainya.
 */
export const SOL_REFERENCE_RAISE_RAW = "85000000000";

const quoteRaises = new Map<string, bigint>();

/** Raise mentah sebuah quote, dari katalog quote (pairs.ts). */
export function rememberQuoteRaise(quoteMint: string, raiseRaw: string) {
  if (/^[1-9][0-9]*$/.test(raiseRaw)) quoteRaises.set(quoteMint, BigInt(raiseRaw));
}

/**
 * Nilai per quote mint. Urutan: entri eksplisit, lalu nilai SOL yang diskalakan dengan raise quote
 * itu, lalu `default`. Desimal pair StonkFun 2–12 dan harganya sangat beragam, jadi satu angka mentah
 * `default` tidak bermakna untuk quote: 1 unit 6 desimal bisa jadi debu atau tidak pernah tercapai.
 * Skala raise tidak butuh harga USD, sehingga batas tetap berlaku saat harga `n/a`. `default` tetap
 * dipakai untuk mint bukan quote (token LIFTOFF) dan quote tanpa raise (registri devnet).
 */
export function perQuote(table: PerQuoteRaw, quoteMint: string): bigint {
  const raise = quoteRaises.get(quoteMint);
  const sol = table[SOL_MINT];
  if (!table[quoteMint] && raise !== undefined && sol !== undefined && /^[0-9]+$/.test(sol)) {
    const scaled = (BigInt(sol) * raise) / BigInt(SOL_REFERENCE_RAISE_RAW);
    return scaled > 0n ? scaled : 1n;
  }
  const v = table[quoteMint] ?? table.default;
  if (v === undefined || !/^[0-9]+$/.test(v))
    throw new Error(`nilai per quote tidak valid: ${quoteMint}`);
  return BigInt(v);
}

/**
 * Parse override env `mint=raw,mint=raw` (alias `sol` = WSOL). Kosong → tabel asli. Dipakai untuk
 * menurunkan threshold HANYA di .env uji lokal; default config tidak berubah.
 */
export function parsePerQuoteEnv(value: string | undefined, base: PerQuoteRaw): PerQuoteRaw {
  const raw = value?.trim();
  if (!raw) return base;
  const out: PerQuoteRaw = { ...base };
  for (const part of raw.split(",")) {
    const [k, v] = part.split("=").map((s) => s.trim());
    if (!k || !v || !/^[0-9]+$/.test(v))
      throw new Error(`format override per quote salah: ${part}`);
    out[k === "sol" ? SOL_MINT : k] = v;
  }
  return out;
}

/** Jenis operasi economic engine; juga tujuan tanda tangan di signer. */
export const ECONOMIC_OP_KINDS = [
  "claim_curve",
  "claim_cpmm",
  "buyback",
  "burn",
  "reserve_fund",
  "reserve_deploy",
  /** Creator fee yang diteruskan StonkFun (strategi `forwarded`), diamati — tidak ditandatangani. */
  "fee_forward",
] as const;
export type EconomicOpKind = (typeof ECONOMIC_OP_KINDS)[number];

export const ECONOMIC_OP_STATUSES = [
  "pending",
  "signed",
  "submitted",
  "confirmed",
  "failed",
  "expired",
] as const;
export type EconomicOpStatus = (typeof ECONOMIC_OP_STATUSES)[number];
export const ACTIVE_OP_STATUSES: readonly EconomicOpStatus[] = ["pending", "signed", "submitted"];
