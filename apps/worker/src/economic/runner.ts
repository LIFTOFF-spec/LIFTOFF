/**
 * Siklus worker economic engine dengan lease + heartbeat (Spec §20 Reliability: idempoten, retry,
 * error logging, emergency pause lewat signer). Lease mencegah dua proses menjalankan siklus yang
 * sama bersamaan (keamanan dana tetap dijaga index unik + CAS di engine bila lease gagal).
 */
import type { Prisma } from "@liftoff/db";
import { heldEconomicFunds, type Db, type FundsSnapshot } from "@liftoff/db";
import { WSOL_MINT, type PlatformAddresses } from "@liftoff/shared";
import type { CycleResult, EconomicEngine } from "./engine";
import type { EconomicChain, EconomicLogger } from "./ports";
import type { ReserveWorker } from "./reserve";

export type EconomicWorkerName =
  "economic:fee-processing" | "economic:buyback" | "economic:reserve";

export async function acquireLease(db: Db, name: string, owner: string, ttlMs: number) {
  const rows = await db.$queryRaw<Array<{ name: string }>>`
    INSERT INTO "worker_heartbeats" ("name", "lastRunAt", "leaseOwner", "leaseUntil")
    VALUES (${name}, now(), ${owner}, now() + (${ttlMs} * interval '1 millisecond'))
    ON CONFLICT ("name") DO UPDATE
      SET "leaseOwner" = EXCLUDED."leaseOwner", "leaseUntil" = EXCLUDED."leaseUntil"
      WHERE "worker_heartbeats"."leaseUntil" IS NULL
         OR "worker_heartbeats"."leaseUntil" < now()
         OR "worker_heartbeats"."leaseOwner" = EXCLUDED."leaseOwner"
    RETURNING "name"`;
  return rows.length === 1;
}

export async function releaseLease(db: Db, name: string, owner: string) {
  await db.workerHeartbeat.updateMany({
    where: { name, leaseOwner: owner },
    data: { leaseUntil: null },
  });
}

async function beat(
  db: Db,
  name: string,
  ok: boolean,
  error: string | null,
  details?: Record<string, unknown>,
) {
  const now = new Date();
  await db.workerHeartbeat.upsert({
    where: { name },
    create: {
      name,
      lastRunAt: now,
      lastOkAt: ok ? now : null,
      consecutiveFailures: ok ? 0 : 1,
      lastError: error,
      details: (details ?? {}) as Prisma.InputJsonValue,
    },
    update: {
      lastRunAt: now,
      ...(ok ? { lastOkAt: now, consecutiveFailures: 0, lastError: null } : {}),
      ...(!ok ? { consecutiveFailures: { increment: 1 }, lastError: error } : {}),
      ...(details ? { details: details as Prisma.InputJsonValue } : {}),
    },
  });
}

/** Snapshot dana: saldo SOL master + saldo ATA quote master vs dana yang dipegang menurut ledger. */
export async function fundsSnapshot(
  db: Db,
  chain: EconomicChain,
  opts: { nativeFeeFunds?: boolean } = {},
): Promise<FundsSnapshot> {
  const held = await heldEconomicFunds(db);
  const masterLamports = await chain.masterLamports();
  const balances: Record<string, string> = {};
  for (const mint of held.keys()) {
    const inAccount = await chain.tokenBalance(await chain.masterTokenAccount(mint));
    // Fee yang diteruskan sebagai SOL biasa berada di saldo wallet, bukan di akun WSOL.
    const native = opts.nativeFeeFunds && mint === WSOL_MINT ? masterLamports : 0n;
    balances[mint] = (inAccount + native).toString();
  }
  return {
    masterLamports: masterLamports.toString(),
    balances,
    held: Object.fromEntries([...held].map(([k, v]) => [k, v.toString()])),
  };
}

export interface RunOptions {
  db: Db;
  engine: EconomicEngine;
  chain: EconomicChain;
  /** Conviction Reserve Worker (Tahap 8); wajib untuk siklus `economic:reserve`. */
  reserve?: ReserveWorker;
  platform: PlatformAddresses;
  owner: string;
  leaseMs: number;
  logger: EconomicLogger;
  lowMasterBalanceLamports: bigint;
  alertConsecutiveFailures: number;
  /** Strategi `forwarded`: saldo SOL master ikut dihitung sebagai dana fee pair SOL. */
  nativeFeeFunds?: boolean;
}

/** Satu siklus worker; error tidak pernah melempar keluar (dicatat di heartbeat untuk alert). */
export async function runWorkerCycle(
  name: EconomicWorkerName,
  o: RunOptions,
): Promise<CycleResult | null> {
  if (!(await acquireLease(o.db, name, o.owner, o.leaseMs))) {
    o.logger.info({ worker: name }, "lease dipegang proses lain; siklus dilewati");
    return null;
  }
  const started = Date.now();
  try {
    const res =
      name === "economic:fee-processing"
        ? await o.engine.runFeeProcessing()
        : name === "economic:buyback"
          ? await o.engine.runBuyback()
          : await requireReserve(o).run();
    let details: Record<string, unknown> | undefined;
    if (name === "economic:reserve")
      details = { vaults: await requireReserve(o).reconcileVaults() };
    if (name === "economic:fee-processing") {
      const snap = await fundsSnapshot(o.db, o.chain, {
        nativeFeeFunds: o.nativeFeeFunds === true,
      });
      details = { ...snap };
      if (BigInt(snap.masterLamports) < o.lowMasterBalanceLamports) {
        o.logger.warn(
          { masterLamports: snap.masterLamports },
          "ALERT: saldo SOL master wallet rendah",
        );
      }
      for (const [mint, held] of Object.entries(snap.held)) {
        if (BigInt(snap.balances[mint] ?? "0") < BigInt(held)) {
          o.logger.warn(
            { mint, held, onchain: snap.balances[mint] },
            "ALERT: selisih ledger vs saldo on-chain",
          );
        }
      }
    }
    await beat(o.db, name, true, res.blocked ? `tertahan: ${res.blocked}` : null, details);
    o.logger.info({ worker: name, ...res, ms: Date.now() - started }, "siklus selesai");
    return res;
  } catch (err) {
    const message = (err as Error).message;
    await beat(o.db, name, false, message).catch(() => undefined);
    const hb = await o.db.workerHeartbeat.findUnique({ where: { name } }).catch(() => null);
    o.logger.warn(
      { worker: name, err: message, consecutiveFailures: hb?.consecutiveFailures ?? null },
      (hb?.consecutiveFailures ?? 0) >= o.alertConsecutiveFailures
        ? "ALERT: worker gagal berulang"
        : "siklus gagal",
    );
    return null;
  } finally {
    await releaseLease(o.db, name, o.owner).catch(() => undefined);
  }
}

function requireReserve(o: RunOptions): ReserveWorker {
  if (!o.reserve) throw new Error("siklus economic:reserve butuh ReserveWorker");
  return o.reserve;
}
