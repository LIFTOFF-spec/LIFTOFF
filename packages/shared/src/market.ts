/**
 * Data pasar dari indexer (Tahap 6, Spec §15–17): parameter indexer dan aritmetika harga tanpa
 * float. Harga disimpan sebagai string desimal "quote per 1 token" (unit tampilan) dengan
 * PRICE_SCALE digit pecahan; semua nominal lain dalam satuan terkecil (bigint).
 */
import type { StatStatus } from "./api";

export interface IndexerConfig {
  /** Jeda antar siklus polling semua token. */
  pollIntervalMs: number;
  /** Jumlah holder memakai getProgramAccounts (mahal) → disegarkan lebih jarang. */
  holdersRefreshMs: number;
  /** Snapshot lebih tua dari ini ditampilkan `delayed`, bukan `verified`. */
  staleAfterMs: number;
  /** Batas getSignaturesForAddress per halaman (maks RPC 1000). */
  signaturePageLimit: number;
  /** Batas transaksi yang diproses per alamat per siklus (sisanya siklus berikutnya). */
  maxTransactionsPerCycle: number;
  /** Jeda minimum antar panggilan RPC (rate limit RPC publik devnet). */
  rpcMinIntervalMs: number;
  /** Backoff eksponensial setelah error RPC: awal & maksimum. */
  backoffInitialMs: number;
  backoffMaxMs: number;
}

export const INDEXER_CONFIG: IndexerConfig = {
  pollIntervalMs: 15_000,
  holdersRefreshMs: 5 * 60_000,
  staleAfterMs: 3 * 60_000,
  signaturePageLimit: 1_000,
  maxTransactionsPerCycle: 200,
  rpcMinIntervalMs: 150,
  backoffInitialMs: 2_000,
  backoffMaxMs: 120_000,
};

/** Digit pecahan harga (cukup untuk ±1e-12 quote/token dengan presisi penuh). */
export const PRICE_SCALE = 30;

const pow10 = (n: number) => 10n ** BigInt(n);

/** Satuan terkecil → string desimal polos ("1102540", 9 → "0.00110254"). */
export function rawToDecimal(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = pow10(decimals);
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${abs / base}${frac ? `.${frac}` : ""}`;
}

/** String desimal → bigint berskala 10^scale (dipotong). Melempar jika bukan angka desimal. */
export function decimalToScaled(value: string, scale = PRICE_SCALE): bigint {
  const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(value.trim());
  if (!m) throw new Error(`bukan angka desimal: ${value}`);
  const frac = (m[3] ?? "").slice(0, scale).padEnd(scale, "0");
  const v = BigInt(`${m[2]}${frac}`);
  return m[1] ? -v : v;
}

/**
 * Harga spot dari cadangan (satuan terkecil): quote per 1 token dalam unit tampilan.
 * Mis. 135.295.121 lamport / 279.925.609.049.470 unit (6 desimal) → "0.000000000483…".
 */
export function priceFromReserves(
  quoteRaw: bigint,
  baseRaw: bigint,
  quoteDecimals: number,
  baseDecimals: number,
): string | null {
  if (baseRaw <= 0n || quoteRaw < 0n) return null;
  const scaled = (quoteRaw * pow10(baseDecimals + PRICE_SCALE)) / (baseRaw * pow10(quoteDecimals));
  return rawToDecimal(scaled, PRICE_SCALE);
}

/** Nilai `amountRaw` token pada `price` → quote dalam satuan terkecil (dipotong). */
export function valueAtPrice(
  price: string,
  amountRaw: bigint,
  baseDecimals: number,
  quoteDecimals: number,
): bigint {
  return (
    (decimalToScaled(price) * amountRaw * pow10(quoteDecimals)) / pow10(PRICE_SCALE + baseDecimals)
  );
}

/** Progres curve dalam persen (2 desimal, maks 100). */
export function curveProgressPct(raised: bigint, target: bigint): string {
  if (target <= 0n) return "0";
  const bps = (raised * 10_000n) / target;
  return rawToDecimal(bps > 10_000n ? 10_000n : bps, 2);
}

/** Perubahan persen dari `from` ke `to` (1 desimal). null jika tidak ada pembanding. */
export function pctChange(from: string | null, to: string | null): string | null {
  if (from === null || to === null) return null;
  const a = decimalToScaled(from);
  const b = decimalToScaled(to);
  if (a === 0n) return null;
  return rawToDecimal(((b - a) * 1_000n) / a, 1);
}

/** Snapshot segar → `verified`; tertinggal → `delayed` (Spec §16: bedakan data tertunda). */
export function freshness(
  indexedAt: Date,
  now = Date.now(),
  staleAfterMs = INDEXER_CONFIG.staleAfterMs,
): Extract<StatStatus, "verified" | "delayed"> {
  return now - indexedAt.getTime() > staleAfterMs ? "delayed" : "verified";
}
