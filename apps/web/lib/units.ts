import { RAYDIUM_RATE_DENOMINATOR } from "@liftoff/shared";

/**
 * Konversi jumlah desimal ↔ satuan terkecil on-chain (bigint), tanpa float, supaya jumlah yang
 * dikirim ke API persis sama dengan yang diketik pengguna. null = input tidak valid.
 */
export function parseUnits(text: string, decimals: number): bigint | null {
  const t = text.trim().replace(",", ".");
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return null;
  const [int = "", frac = ""] = t.split(".");
  if (frac.length > decimals) return null;
  return BigInt(`${int || "0"}${frac.padEnd(decimals, "0")}`);
}

/** Satuan terkecil → string desimal "1,234.5678" (dipotong, bukan dibulatkan). */
export function formatUnits(
  raw: string | bigint,
  decimals: number,
  maxFraction = decimals,
): string {
  const value = BigInt(raw);
  const neg = value < 0n;
  const digits = (neg ? -value : value).toString().padStart(decimals + 1, "0");
  const int = decimals > 0 ? digits.slice(0, -decimals) : digits;
  const frac = decimals > 0 ? digits.slice(-decimals).slice(0, maxFraction).replace(/0+$/, "") : "";
  const grouped = BigInt(int).toLocaleString("en-US");
  return `${neg ? "-" : ""}${grouped}${frac ? `.${frac}` : ""}`;
}

/** Satuan terkecil → string desimal polos tanpa pemisah ribuan (untuk mengisi input). */
export function toPlainUnits(raw: string | bigint, decimals: number): string {
  return formatUnits(raw, decimals).replace(/,/g, "");
}

/** Rate on-chain Raydium (per 1_000_000) → "0.25%". */
export function formatRate(rate: number): string {
  const pct = (rate / RAYDIUM_RATE_DENOMINATOR) * 100;
  return `${pct.toLocaleString("en-US", { maximumFractionDigits: 3 })}%`;
}
