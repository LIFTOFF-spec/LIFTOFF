/**
 * Kuota launch per wallet (D9 revisi): N launch job dalam 24 jam bergulir, lebih besar jika
 * wallet menautkan akun X. Dihitung dari `launch_jobs` (sumber kebenaran, tanpa tabel kuota
 * terpisah); pemanggil di dalam transaksi mengambil advisory lock per wallet lebih dulu supaya
 * hitung-lalu-sisipkan bersifat atomik.
 */
import type { Db, DbTx } from "@liftoff/db";
import type { LaunchLimitsConfig } from "@liftoff/shared";

export const WALLET_WINDOW_MS = 24 * 60 * 60 * 1000;

export function walletLimit(limits: LaunchLimitsConfig, hasX: boolean): number {
  return hasX ? limits.perWalletWithXPer24h : limits.perWalletPer24h;
}

export function countWalletLaunches(db: Db | DbTx, userId: string, now = Date.now()) {
  return db.launchJob.count({
    where: { userId, createdAt: { gt: new Date(now - WALLET_WINDOW_MS) } },
  });
}

/** Mengunci kuota wallet sampai transaksi selesai. */
export async function lockWallet(tx: DbTx, wallet: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`wallet:${wallet}`}, 0))`;
}

export function walletLimitMessage(limit: number, hasX: boolean, limits: LaunchLimitsConfig) {
  const base = `This wallet reached its launch limit (${limit} per 24 hours).`;
  return hasX || limits.perWalletWithXPer24h <= limits.perWalletPer24h
    ? `${base} Try again later.`
    : `${base} Link an X account to raise it to ${limits.perWalletWithXPer24h}, or try again later.`;
}
