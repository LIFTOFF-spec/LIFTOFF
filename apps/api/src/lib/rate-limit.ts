import type { RateLimitRule } from "@liftoff/shared";
import { HttpError } from "./errors";
import type { KvStore } from "./kv";

export interface RateSubject {
  ip: string;
  /** ID user (akun X) jika login. */
  userId?: string | null | undefined;
  wallet?: string | null | undefined;
}

/**
 * Fixed-window rate limit per IP, per user, dan per wallet. Setiap dimensi punya kuota
 * sendiri; request ditolak jika salah satunya habis. Jika store tidak bisa dihubungi,
 * request DITOLAK (fail-closed) karena launch dibayar treasury.
 */
export async function enforceRateLimit(
  kv: KvStore,
  scope: string,
  rule: RateLimitRule,
  subject: RateSubject,
): Promise<void> {
  const window = Math.floor(Date.now() / 1000 / rule.windowSeconds);
  const keys = [
    `rl:${scope}:ip:${subject.ip}:${window}`,
    subject.userId ? `rl:${scope}:x:${subject.userId}:${window}` : null,
    subject.wallet ? `rl:${scope}:wallet:${subject.wallet}:${window}` : null,
  ].filter((k): k is string => k !== null);

  let counts: number[];
  try {
    counts = await Promise.all(keys.map((k) => kv.incr(k, rule.windowSeconds)));
  } catch {
    throw new HttpError(
      503,
      "rate_limit_unavailable",
      "Rate limiter unavailable. Try again later.",
    );
  }
  if (counts.some((c) => c > rule.max)) {
    const retryAfter = rule.windowSeconds - (Math.floor(Date.now() / 1000) % rule.windowSeconds);
    throw new HttpError(
      429,
      "rate_limited",
      "Too many requests. Slow down and try again later.",
      undefined,
      {
        "retry-after": String(retryAfter),
      },
    );
  }
}

/** Tanggal UTC (YYYY-MM-DD) untuk kuota harian. */
export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Mengambil satu slot kuota launch harian GLOBAL (UTC). Mengembalikan fungsi untuk mengembalikan
 * slot jika launch akhirnya tidak dibuat. Kuota per wallet ada di launch-quota.ts (DB).
 */
export async function takeGlobalLaunchQuota(
  kv: KvStore,
  globalPerDay: number,
): Promise<() => Promise<void>> {
  const key = `quota:launch:global:${utcDay()}`;
  let count: number;
  try {
    count = await kv.incr(key, 2 * 24 * 60 * 60);
  } catch {
    throw new HttpError(
      503,
      "quota_unavailable",
      "Launch quota service unavailable. Try again later.",
    );
  }
  const release = async () => {
    await kv.decr(key).catch(() => undefined);
  };
  if (count > globalPerDay) {
    await release();
    throw new HttpError(
      429,
      "daily_limit_global",
      "LIFTOFF reached today's launch limit. Launches reopen at 00:00 UTC.",
    );
  }
  return release;
}
