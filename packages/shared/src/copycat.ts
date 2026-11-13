/**
 * Anti-copycat Spec §7: indikator duplikasi + klasifikasi risiko Low / Medium / High.
 *
 * Indikator (masing-masing punya bobot di ANTI_COPYCAT_CONFIG.riskWeights):
 *  - nama sama / mirip nama token lain di LIFTOFF;
 *  - ticker sama / look-alike ticker token lain di LIFTOFF (BUKAN penipuan otomatis, Spec §7);
 *  - ticker yang sudah diperdagangkan di luar LIFTOFF dengan likuiditas nyata;
 *  - gambar hampir identik (pHash);
 *  - akun X / website / Telegram yang sudah dipakai token lain.
 * Skor = jumlah bobot. 0 → Low, < highRiskScore → Medium, ≥ highRiskScore → High ("multiple
 * indicators suggest possible impersonation"). High diblok otomatis dan bisa diajukan banding.
 */
import { normalizeTicker } from "./ticker";

export type RiskLevel = "low" | "medium" | "high";

export const RISK_INDICATORS = [
  "name_identical",
  "name_similar",
  "ticker_repeated",
  "ticker_external",
  "image_similar",
  "social_x_reused",
  "social_website_reused",
  "social_telegram_reused",
] as const;
export type RiskIndicatorCode = (typeof RISK_INDICATORS)[number];

export interface RiskIndicator {
  code: RiskIndicatorCode;
  /** Kolom form yang terkait (untuk menyorot input). */
  field: "name" | "ticker" | "image" | "x" | "website" | "telegram";
  weight: number;
  /** Penjelasan yang dibaca pengguna (Spec §7: "explain why a launch is flagged"). */
  message: string;
  /** Token pembanding (ticker), jika ada. */
  relatedTicker: string | null;
}

export interface RiskAssessment {
  level: RiskLevel;
  score: number;
  indicators: RiskIndicator[];
}

export interface RiskThresholds {
  riskWeights: Record<RiskIndicatorCode, number>;
  highRiskScore: number;
}

export function classifyRisk(indicators: RiskIndicator[], t: RiskThresholds): RiskAssessment {
  const score = indicators.reduce((acc, i) => acc + i.weight, 0);
  const level: RiskLevel = score === 0 ? "low" : score >= t.highRiskScore ? "high" : "medium";
  return { level, score, indicators };
}

// ---------------------------------------------------------------- nama

/**
 * Bentuk pembanding nama: lipatan yang sama dengan ticker (homoglyph, leetspeak, l/i), lalu
 * buang kata generik di akhir ("token", "coin", "inu", "official") agar "Pepe Coin" ≈ "PEPE".
 */
// Dilipat dengan aturan yang sama ("official" → "officiai" karena l/i disatukan).
const GENERIC_SUFFIXES = ["official", "token", "coin", "inu"].map(normalizeTicker);

export function normalizeName(raw: string): string {
  let s = normalizeTicker(raw);
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of GENERIC_SUFFIXES) {
      if (s.length > suffix.length + 2 && s.endsWith(suffix)) {
        s = s.slice(0, -suffix.length);
        changed = true;
      }
    }
  }
  return s;
}

/** Jarak Levenshtein (iteratif, O(n·m), nama ≤ 32 karakter). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** Kemiripan 0–1 antara dua nama ternormalisasi (1 = identik). */
export function nameSimilarity(a: string, b: string): number {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x.length || !y.length) return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

// ---------------------------------------------------------------- tautan sosial

/**
 * Bentuk kanonik akun X: handle huruf kecil tanpa `@`. Menerima `@handle`, `handle`, atau URL
 * x.com / twitter.com. null jika bukan akun X yang valid.
 */
export function normalizeXAccount(raw: string | null | undefined): string | null {
  const s = raw?.trim();
  if (!s) return null;
  const m =
    /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})(?:[/?#].*)?$/i.exec(
      s,
    ) ?? /^@?([A-Za-z0-9_]{1,15})$/.exec(s);
  return m ? m[1]!.toLowerCase() : null;
}

/** Website kanonik: host tanpa `www.` + path tanpa `/` di akhir, huruf kecil, tanpa query. */
export function normalizeWebsite(raw: string | null | undefined): string | null {
  const s = raw?.trim();
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "").toLowerCase();
    return host ? `${host}${path}` : null;
  } catch {
    return null;
  }
}

/** Telegram kanonik: nama grup/kanal huruf kecil dari t.me/… atau telegram.me/…. */
export function normalizeTelegram(raw: string | null | undefined): string | null {
  const s = raw?.trim();
  if (!s) return null;
  const m = /^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/(?:s\/)?([A-Za-z0-9_+-]{2,64})/i.exec(
    s,
  );
  return m ? m[1]!.toLowerCase() : normalizeWebsite(s);
}
