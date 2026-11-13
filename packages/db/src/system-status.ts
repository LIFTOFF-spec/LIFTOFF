/**
 * Ringkasan status sistem (Tahap 9): satu tempat untuk semua alert berbasis DB — economic engine
 * (worker, saldo master, selisih ledger, rekonsiliasi, operasi gagal, signer dipause, termasuk
 * worker Conviction Reserve), indexer tertinggal / error, dan launch job yang macet. Dipakai
 * `GET /api/health/status` dan proses `monitor` worker (notifikasi eksternal).
 * Pesan yang keluar dibersihkan dari URL (URL RPC bisa memuat API key).
 */
import { ECONOMIC_CONFIG, MONITOR_CONFIG } from "@liftoff/shared";
import { economicHealth, type EconomicHealth } from "./economic-health";
import type { Db } from "./index";

export type SystemAlertCode =
  EconomicHealth["alerts"][number]["code"] | "indexer_lagging" | "indexer_errors" | "launch_stuck";

export interface SystemAlert {
  level: "warn" | "critical";
  code: SystemAlertCode | (string & {});
  message: string;
}

export interface SystemStatus {
  status: "ok" | "degraded";
  checkedAt: string;
  alerts: SystemAlert[];
  economic: EconomicHealth;
  indexer: {
    liveTokens: number;
    /** Snapshot pasar terbaru (token_markets.indexedAt). */
    lastIndexedAt: string | null;
    lagMs: number | null;
    erroringAddresses: number;
  };
  signerPaused: boolean;
}

export interface SystemStatusOptions {
  now: Date;
  economic: Omit<Parameters<typeof economicHealth>[1], "now">;
  /** Alert bila snapshot pasar terbaru lebih tua dari ini. */
  indexerLagAlertMs: number;
  /** Alert bila alamat indexer gagal berturut-turut sebanyak ini. */
  indexerErrorAlertCount: number;
  /** Launch job submitting/confirming lebih lama dari ini dianggap macet. */
  launchStuckAfterMs: number;
}

/** Ambang default (ECONOMIC_CONFIG + MONITOR_CONFIG), dipakai API dan proses monitor. */
export function defaultSystemStatusOptions(now = new Date()): SystemStatusOptions {
  const E = ECONOMIC_CONFIG;
  return {
    now,
    economic: {
      lowMasterBalanceLamports: BigInt(E.lowMasterBalanceLamports),
      alertConsecutiveFailures: E.alertConsecutiveFailures,
      // Worker dianggap berhenti bila melewatkan 3 interval siklusnya.
      staleAfterMs: 3 * Math.max(E.claimIntervalMs, E.buybackIntervalMs),
      maxAttemptsPerTarget: E.maxAttemptsPerTarget,
    },
    indexerLagAlertMs: MONITOR_CONFIG.indexerLagAlertMs,
    indexerErrorAlertCount: MONITOR_CONFIG.indexerErrorAlertCount,
    launchStuckAfterMs: MONITOR_CONFIG.launchStuckAfterMs,
  };
}

/** Menghapus URL (bisa memuat API key) dan nilai mirip secret dari teks yang dipublikasikan. */
export function redactSecrets(text: string | null): string | null {
  if (text === null) return null;
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi, "[url]")
    .replace(/((?:api[-_]?key|token|secret|password)\s*[=:]\s*)[^\s&"',]+/gi, "$1[redacted]");
}

/** Versi publik EconomicHealth: tanpa `details` mentah, pesan & error tanpa URL. */
export function redactEconomicHealth(h: EconomicHealth): EconomicHealth {
  return {
    ...h,
    alerts: h.alerts.map((a) => ({
      level: a.level,
      code: a.code,
      message: redactSecrets(a.message)!,
    })),
    workers: h.workers.map((w) => ({ ...w, lastError: redactSecrets(w.lastError) })),
  };
}

export async function systemStatus(db: Db, opts: SystemStatusOptions): Promise<SystemStatus> {
  const economic = await economicHealth(db, { ...opts.economic, now: opts.now });
  const alerts: SystemAlert[] = economic.alerts.map((a) => ({
    level: a.level,
    code: a.code,
    message: redactSecrets(a.message)!,
  }));

  const [liveTokens, latest, erroring, stuck] = await Promise.all([
    db.token.count({ where: { launchStatus: "live", mint: { not: null } } }),
    db.tokenMarket.aggregate({ _max: { indexedAt: true } }),
    db.indexerCheckpoint.count({ where: { errorCount: { gte: opts.indexerErrorAlertCount } } }),
    db.launchJob.count({
      where: {
        status: { in: ["submitting", "confirming"] },
        updatedAt: { lt: new Date(opts.now.getTime() - opts.launchStuckAfterMs) },
      },
    }),
  ]);
  const lastIndexedAt = latest._max.indexedAt ?? null;
  const lagMs = lastIndexedAt ? opts.now.getTime() - lastIndexedAt.getTime() : null;
  if (liveTokens > 0 && (lagMs === null || lagMs > opts.indexerLagAlertMs)) {
    alerts.push({
      level: "critical",
      code: "indexer_lagging",
      message:
        lagMs === null
          ? `indexer belum pernah menulis snapshot untuk ${liveTokens} token live`
          : `snapshot indexer terakhir ${Math.round(lagMs / 1000)} detik lalu`,
    });
  }
  if (erroring > 0) {
    alerts.push({
      level: "warn",
      code: "indexer_errors",
      message: `${erroring} alamat indexer gagal ≥ ${opts.indexerErrorAlertCount}× berturut-turut`,
    });
  }
  if (stuck > 0) {
    alerts.push({
      level: "critical",
      code: "launch_stuck",
      message: `${stuck} launch job tertahan di submitting/confirming`,
    });
  }

  return {
    status: alerts.some((a) => a.level === "critical") ? "degraded" : "ok",
    checkedAt: opts.now.toISOString(),
    alerts,
    economic: redactEconomicHealth(economic),
    indexer: {
      liveTokens,
      lastIndexedAt: lastIndexedAt?.toISOString() ?? null,
      lagMs,
      erroringAddresses: erroring,
    },
    signerPaused: economic.alerts.some((a) => a.code === "signer_paused"),
  };
}
