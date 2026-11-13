import { BPS_DENOMINATOR, DEFAULT_SOLANA_CLUSTER, isSolanaCluster } from "@liftoff/shared";
import type { FeeClaimView, UsedPair, SolanaCluster } from "@liftoff/shared";

/** Cluster aktif dari env (default devnet, Aturan #1). */
export function getCluster(): SolanaCluster {
  const value = process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? DEFAULT_SOLANA_CLUSTER;
  return isSolanaCluster(value) ? value : DEFAULT_SOLANA_CLUSTER;
}

/** bps → "1%" / "0.5%" — angka dari config, bukan ditulis manual (Aturan #10). */
export function claimLabel(kind: FeeClaimView["kind"]): string {
  if (kind === "fee_forward") return "StonkFun forward";
  return kind === "claim_cpmm" ? "Pool claim" : "Vault claim";
}

export function formatBps(bps: number): string {
  const pct = (bps / BPS_DENOMINATOR) * 100;
  return `${pct.toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
}

/** Bagian bps dari bps lain, mis. porsi reserve dari platform fee. */
export function bpsOf(partBps: number, ofBps: number): number {
  return (partBps * ofBps) / BPS_DENOMINATOR;
}

export function formatNumber(value: string | number, maxFractionDigits = 2): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: maxFractionDigits });
}

export function formatCompact(value: string | number): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
}

export function formatUsd(value: string | number, compact = true): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "—";
  if (n !== 0 && Math.abs(n) < 0.01) return formatPrice(n);
  return `$${compact ? formatCompact(n) : formatNumber(n)}`;
}

const SUBSCRIPT_DIGITS = "₀₁₂₃₄₅₆₇₈₉";

/** Nilai positif < 1, 4 digit signifikan: nol sesudah koma diringkas, 0.000002595 → "0.0₅2595". */
function smallDecimal(abs: number): string {
  const [mantissa = "", exponent = "0"] = abs.toExponential(3).split("e");
  const zeros = -Number(exponent) - 1;
  if (zeros < 3) return abs.toLocaleString("en-US", { maximumSignificantDigits: 4 });
  const digits = mantissa.replace(".", "").replace(/0+$/, "");
  const subscript = String(zeros).replace(/\d/g, (d) => SUBSCRIPT_DIGITS[Number(d)] ?? d);
  return `0.0${subscript}${digits}`;
}

/** Harga USD: "$0.0₅2595" untuk nilai sangat kecil; nilai ≥ 1 mengikuti formatUsd. */
export function formatPrice(value: string | number): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "$0";
  if (Math.abs(n) >= 1) return formatUsd(n);
  return `${n < 0 ? "-" : ""}$${smallDecimal(Math.abs(n))}`;
}

/** Harga dalam quote pair untuk chart: format sama dengan formatPrice, tanpa simbol mata uang. */
export function formatChartPrice(value: string | number): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  if (Math.abs(n) >= 1) return n.toLocaleString("en-US", { maximumSignificantDigits: 6 });
  return `${n < 0 ? "-" : ""}${smallDecimal(Math.abs(n))}`;
}

/**
 * Jumlah token/quote: ringkas untuk ≥ 1, 4 digit signifikan untuk nilai kecil (harga token
 * curve bisa ~1e-10 SOL, yang dengan formatCompact akan tampil "0").
 */
export function formatAmount(value: string | number): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  if (Math.abs(n) >= 1) return formatCompact(n);
  return n.toLocaleString("en-US", { maximumSignificantDigits: 4 });
}

/** Format nilai Stat sesuai unit-nya. */
export function formatStatValue(value: string, unit: string): string {
  switch (unit) {
    case "USD":
      return formatUsd(value);
    case "%":
      return `${formatNumber(value, 2)}%`;
    default:
      return `${formatAmount(value)} ${unit}`;
  }
}

export function shortAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 1) return address;
  return `${address.slice(0, chars)}…${address.slice(-chars)}`;
}

export function explorerUrl(kind: "tx" | "address", id: string): string {
  const cluster = getCluster();
  const suffix = cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`;
  return `https://explorer.solana.com/${kind}/${id}${suffix}`;
}

/** Durasi (detik) → "6 hr", "1 day 2 hr", "45 min". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  if (d > 0) return h > 0 ? `${days(d)} ${h} hr` : days(d);
  if (h > 0) return m > 0 ? `${h} hr ${m} min` : `${h} hr`;
  if (m > 0) return `${m} min`;
  return `${s} sec`;
}

function days(d: number): string {
  return d === 1 ? "1 day" : `${d} days`;
}

/** Hitung mundur presisi detik: "12 days 04:31:09". */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400);
  const hh = String(Math.floor((s % 86_400) / 3_600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3_600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${d > 0 ? `${days(d)} ` : ""}${hh}:${mm}:${ss}`;
}

export function formatRelative(iso: string, now: number): string {
  const diff = Math.round((now - Date.parse(iso)) / 1000);
  const future = diff < 0;
  const label = formatDuration(Math.abs(diff));
  if (Math.abs(diff) < 10) return "just now";
  return future ? `in ${label}` : `${label} ago`;
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

/**
 * Label pair untuk filter/tag: "/SOL". Simbol yang dipakai lebih dari satu pair diberi pembeda:
 * "/SOL (config 1)", atau mint singkat bila mint-nya memang berbeda.
 */
export function pairLabel(pair: UsedPair, all: UsedPair[]): string {
  const same = all.filter((p) => p.symbol === pair.symbol);
  if (same.length <= 1) return `/${pair.symbol}`;
  const config = /\(([^)]+)\)/.exec(pair.name)?.[1];
  const detail = same.every((p) => p.mint === pair.mint) ? config : shortAddress(pair.mint);
  return detail ? `/${pair.symbol} (${detail})` : `/${pair.symbol}`;
}

/** Label kreator: handle X tertaut (verified) atau alamat wallet singkat. */
export function creatorLabel(token: {
  creatorWallet: string;
  creatorXHandle: string | null;
}): string {
  return token.creatorXHandle ?? shortAddress(token.creatorWallet);
}
