/**
 * Alert dasar economic engine (Tahap 7): worker gagal berulang / berhenti, saldo SOL master rendah,
 * selisih ledger (dana yang menurut ledger dipegang master > saldo akun on-chain, atau rekonsiliasi
 * `estimated`), operasi yang terus gagal, signer dipause. Dipakai worker (log) dan API
 * (`GET /api/health/economic`). Angka on-chain berasal dari heartbeat yang ditulis worker.
 */
import type { Db } from "./index";

export type EconomicAlertCode =
  | "worker_failing"
  | "worker_stale"
  | "master_low_balance"
  | "ledger_mismatch"
  | "reconciliation_estimated"
  | "op_failing"
  | "signer_paused";

export interface EconomicAlert {
  level: "warn" | "critical";
  code: EconomicAlertCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface WorkerBeatView {
  name: string;
  lastRunAt: string;
  lastOkAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
}

export interface EconomicHealth {
  status: "ok" | "degraded";
  checkedAt: string;
  alerts: EconomicAlert[];
  workers: WorkerBeatView[];
  masterLamports: string | null;
  /** Per asset: dana ekonomi menurut ledger vs saldo ATA master on-chain (snapshot worker). */
  funds: Array<{ assetMint: string; heldByLedger: string; onchain: string }>;
}

export interface FundsSnapshot {
  masterLamports: string;
  balances: Record<string, string>;
  held: Record<string, string>;
}

export async function economicHealth(
  db: Db,
  opts: {
    now: Date;
    lowMasterBalanceLamports: bigint;
    alertConsecutiveFailures: number;
    /** Worker dianggap berhenti bila tidak berjalan selama ini. */
    staleAfterMs: number;
    maxAttemptsPerTarget: number;
  },
): Promise<EconomicHealth> {
  const alerts: EconomicAlert[] = [];
  const beats = await db.workerHeartbeat.findMany({
    where: { name: { startsWith: "economic:" } },
    orderBy: { name: "asc" },
  });
  for (const b of beats) {
    if (b.consecutiveFailures >= opts.alertConsecutiveFailures) {
      alerts.push({
        level: "critical",
        code: "worker_failing",
        message: `${b.name} gagal ${b.consecutiveFailures}× berturut-turut`,
        details: { lastError: b.lastError },
      });
    }
    if (opts.now.getTime() - b.lastRunAt.getTime() > opts.staleAfterMs) {
      alerts.push({
        level: "warn",
        code: "worker_stale",
        message: `${b.name} tidak berjalan sejak ${b.lastRunAt.toISOString()}`,
      });
    }
  }

  const fee = beats.find((b) => b.name === "economic:fee-processing");
  const snap = (fee?.details ?? null) as Partial<FundsSnapshot> | null;
  const funds: EconomicHealth["funds"] = [];
  if (snap?.masterLamports !== undefined) {
    if (BigInt(snap.masterLamports) < opts.lowMasterBalanceLamports) {
      alerts.push({
        level: "critical",
        code: "master_low_balance",
        message: `saldo SOL master wallet ${snap.masterLamports} lamport < ${opts.lowMasterBalanceLamports}`,
      });
    }
  }
  for (const [asset, held] of Object.entries(snap?.held ?? {})) {
    const onchain = snap?.balances?.[asset] ?? "0";
    funds.push({ assetMint: asset, heldByLedger: held, onchain });
    if (BigInt(onchain) < BigInt(held)) {
      alerts.push({
        level: "critical",
        code: "ledger_mismatch",
        message: `ledger mencatat ${held} di akun master untuk ${asset}, saldo on-chain ${onchain}`,
      });
    }
  }

  const estimated = await db.feeReconciliation.findMany({
    // Fee diteruskan yang dibagi menurut volume (tanpa ledger per trade) normal, bukan selisih.
    where: { status: "estimated", NOT: { ledgerRaw: 0, unattributedRaw: 0 } },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  for (const r of estimated) {
    alerts.push({
      level: "warn",
      code: "reconciliation_estimated",
      message: `claim ${r.claimOpId}: di-claim ${r.claimedRaw.toFixed(0)} vs ledger ${r.ledgerRaw.toFixed(0)} (koreksi ${r.differenceRaw.toFixed(0)})`,
    });
  }

  // Target yang gagal maxAttempts kali berturut-turut tanpa satu pun sukses sesudahnya.
  const failing = await db.$queryRaw<
    Array<{ kind: string; target: string; n: bigint; lastError: string | null }>
  >`
    SELECT o."kind"::text AS "kind", o."target", count(*) AS "n", max(o."lastError") AS "lastError"
    FROM "economic_ops" o
    WHERE o."status" IN ('failed', 'expired')
      AND o."createdAt" > coalesce((SELECT max(c."createdAt") FROM "economic_ops" c
        WHERE c."kind" = o."kind" AND c."target" = o."target" AND c."status" = 'confirmed'), 'epoch')
    GROUP BY 1, 2 HAVING count(*) >= ${opts.maxAttemptsPerTarget}`;
  for (const f of failing) {
    alerts.push({
      level: "critical",
      code: "op_failing",
      message: `${f.kind} ${f.target} gagal ${f.n}× berturut-turut`,
      details: { lastError: f.lastError },
    });
  }

  const pause = await db.systemFlag.findUnique({ where: { key: "signer.paused" } });
  if ((pause?.value as { paused?: boolean } | null)?.paused === true) {
    alerts.push({
      level: "warn",
      code: "signer_paused",
      message: "signer dipause: economic engine tertahan",
    });
  }

  return {
    status: alerts.some((a) => a.level === "critical") ? "degraded" : "ok",
    checkedAt: opts.now.toISOString(),
    alerts,
    workers: beats.map((b) => ({
      name: b.name,
      lastRunAt: b.lastRunAt.toISOString(),
      lastOkAt: b.lastOkAt?.toISOString() ?? null,
      consecutiveFailures: b.consecutiveFailures,
      lastError: b.lastError,
    })),
    masterLamports: snap?.masterLamports ?? null,
    funds,
  };
}
