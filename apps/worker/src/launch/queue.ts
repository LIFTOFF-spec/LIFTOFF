/**
 * BullMQ queue `launch`. ID job BullMQ = ID launch job, jadi satu launch tidak pernah ada dua
 * kali di antrean. DB tetap sumber kebenaran: sweeper mengantrekan ulang job non-final yang
 * macet (worker restart, enqueue API gagal, percobaan BullMQ habis).
 */
import type { Db } from "@liftoff/db";
import { LAUNCH_QUEUE, type LaunchEngineConfig } from "@liftoff/shared";
import { DelayedError, Queue, Worker, type ConnectionOptions, type Job } from "bullmq";
import type { EngineLogger, LaunchEngine } from "./engine";
import { loadJob, transition, TransitionConflict } from "./store";

export interface LaunchJobData {
  jobId: string;
}

export function launchJobOptions(engine: Pick<LaunchEngineConfig, "queueAttempts">) {
  return {
    attempts: engine.queueAttempts,
    backoff: { type: "exponential" as const, delay: 2_000 },
    removeOnComplete: true,
    removeOnFail: true,
  };
}

export function createLaunchQueue(connection: ConnectionOptions, prefix?: string) {
  return new Queue<LaunchJobData>(LAUNCH_QUEUE, { connection, ...(prefix ? { prefix } : {}) });
}

export async function enqueueLaunch(
  queue: Queue<LaunchJobData>,
  jobId: string,
  engine: Pick<LaunchEngineConfig, "queueAttempts">,
) {
  await queue.add("run", { jobId }, { ...launchJobOptions(engine), jobId });
}

/** Percobaan BullMQ habis saat status on-chain belum jelas → needs_reconciliation. */
export async function flagForReconciliation(db: Db, jobId: string, reason: string) {
  const job = await loadJob(db, jobId);
  if (!job || (job.status !== "submitting" && job.status !== "confirming")) return;
  if (job.status === "submitting" && job.transactions.length === 0) return; // belum ada yang dikirim
  try {
    await db.$transaction((tx) =>
      transition(tx, job, job.status, "needs_reconciliation", {
        lastError: `Launch status is being reconciled after repeated errors (${reason.slice(0, 160)}).`,
      }),
    );
  } catch (err) {
    if (!(err instanceof TransitionConflict)) throw err;
  }
}

export function createLaunchWorker(opts: {
  connection: ConnectionOptions;
  engine: LaunchEngine;
  db: Db;
  concurrency: number;
  logger: EngineLogger;
  /** Prefix key Redis (test memakai prefix tersendiri). */
  prefix?: string;
}) {
  const worker = new Worker<LaunchJobData>(
    LAUNCH_QUEUE,
    async (job: Job<LaunchJobData>, token?: string) => {
      const res = await opts.engine.run(job.data.jobId);
      if (res.kind === "final") return res;
      // Belum final (menunggu konfirmasi / signer dipause): tunda tanpa memakan percobaan.
      await job.moveToDelayed(Date.now() + res.delayMs, token);
      throw new DelayedError();
    },
    {
      connection: opts.connection,
      concurrency: opts.concurrency,
      ...(opts.prefix ? { prefix: opts.prefix } : {}),
    },
  );
  worker.on("failed", (job, err) => {
    if (!job) return;
    opts.logger.warn(
      { jobId: job.data.jobId, attempt: job.attemptsMade, err: err.message },
      "run launch gagal",
    );
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
      void flagForReconciliation(opts.db, job.data.jobId, err.message).catch(() => undefined);
    }
  });
  return worker;
}

/** Mengantrekan ulang job non-final yang tidak berubah selama `staleAfterMs`. */
export async function sweepStaleLaunches(
  db: Db,
  queue: Queue<LaunchJobData>,
  engine: Pick<LaunchEngineConfig, "queueAttempts" | "staleAfterMs">,
  now = new Date(),
): Promise<string[]> {
  const before = new Date(now.getTime() - engine.staleAfterMs);
  const stale = await db.launchJob.findMany({
    where: {
      OR: [
        {
          status: { in: ["queued", "submitting", "confirming", "needs_reconciliation"] },
          updatedAt: { lt: before },
        },
        // Launch gagal dengan refund deposit yang belum selesai.
        { status: "failed", deposit: { status: "refund_pending" } },
      ],
    },
    select: { id: true },
    take: 100,
    orderBy: { updatedAt: "asc" },
  });
  for (const { id } of stale) await enqueueLaunch(queue, id, engine);
  return stale.map((j) => j.id);
}
