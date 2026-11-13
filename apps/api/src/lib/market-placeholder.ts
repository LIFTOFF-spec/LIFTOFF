/**
 * Konversi ke USD (Aturan #3 & #4).
 *
 * Sejak indexer Tahap 6, harga/volume/holder/chart/trade dibaca dari chain (lib/tokens.ts) dan
 * placeholder deterministik dihapus. Yang tersisa di sini hanya konversi ke USD: devnet tidak
 * punya harga, jadi nilai USD memakai harga ASUMSI pair dan SELALU bertanda `source: "mock"`.
 * Mainnet: harga terverifikasi per quote (sol-price.ts) = selalu estimasi; tanpa itu USD tidak tersedia.
 */
import type { Stat, StatStatus, UsdRates } from "@liftoff/shared";

export function trimNumber(n: number): string {
  if (n === 0) return "0";
  if (Math.abs(n) >= 1) return n.toFixed(2).replace(/\.?0+$/, "");
  return n.toPrecision(4).replace(/\.?0+$/, "");
}

/** Jangkar waktu: awal jam berjalan, agar nilai stabil antar request dalam satu jam. */
const anchor = () => Math.floor(Date.now() / 3_600_000) * 3_600_000;

/**
 * Setara USD: estimasi MOCK di devnet; di mainnet estimasi dari harga terverifikasi, atau "tidak
 * tersedia" bila harga tidak terverifikasi. Jumlah native boleh `verified`, setara USD-nya tidak.
 */
export function usdStat(
  rates: UsdRates,
  value: number | null,
  status: StatStatus = "estimated",
): Stat {
  if (rates.kind === "assumed") return mockStat(value, "USD", status);
  // Bukan angka = ada quote tanpa harga terverifikasi di dalamnya (UsdRates.rateFor): n/a, bukan $0.
  if (rates.kind === "none" || value === null || !Number.isFinite(value)) {
    return { value: null, unit: "USD", status: "unavailable", updatedAt: null, source: "indexer" };
  }
  return {
    value: trimNumber(value),
    unit: "USD",
    status: status === "delayed" ? "delayed" : "estimated",
    updatedAt: rates.observedAt,
    source: "price_feed",
  };
}

export function mockStat(
  value: number | null,
  unit: string,
  status: StatStatus = "estimated",
): Stat {
  if (value === null)
    return { value: null, unit, status: "unavailable", updatedAt: null, source: "mock" };
  return {
    value: trimNumber(value),
    unit,
    status,
    updatedAt: new Date(anchor()).toISOString(),
    source: "mock",
  };
}
