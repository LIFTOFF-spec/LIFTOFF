/**
 * Integrasi BullMQ + Redis (docker compose) + Postgres test. Memakai Redis DB 15 dengan prefix
 * acak agar tidak menyentuh antrean development.
 */
import { createPrismaClient, type Db } from "@liftoff/db";
import { prepareTestDatabase, RESETTABLE_TABLES } from "@liftoff/db/testing";
import { LAUNCH_ENGINE, pairsFor, StaticStonkFunAdapter } from "@liftoff/shared";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LaunchEngine } from "./engine";
import { FakeLedger, FakeSender, FakeSigner } from "./fakes";
import {
  createLaunchQueue,
  createLaunchWorker,
  enqueueLaunch,
  flagForReconciliation,
  sweepStaleLaunches,
} from "./queue";

const SOL = pairsFor("devnet").find((p) => p.id === "sol")!;
const silent = { info: () => undefined, warn: () => undefined };
let db: Db;
let redis: Redis;

beforeAll(async () => {
  db = createPrismaClient(await prepareTestDatabase("liftoff_test_worker"));
  redis = new Redis(process.env.REDIS_TEST_URL ?? "redis://localhost:6379/15", {
    maxRetriesPerRequest: null,
  });
});
beforeEach(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE ${RESETTABLE_TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
});
afterAll(async () => {
  await redis.quit();
  await db.$disconnect();
});

async function seed(status: "queued" | "confirming" = "queued") {
  const user = await db.user.create({ data: { wallet: `W${Math.random()}` } });
  const token = await db.token.create({
    data: {
      name: "Q",
      ticker: "Q",
      tickerNormalized: `q${Math.random().toString(36).slice(2)}`,
      quoteMint: SOL.mint,
      quoteConfigId: SOL.configId,
      creatorUserId: user.id,
      launchStatus: status,
    },
  });
  return db.launchJob.create({
    data: {
      tokenId: token.id,
      userId: user.id,
      idempotencyKey: `k${Math.random().toString(36).slice(2)}`,
      requestHash: "h",
      status,
    },
  });
}

function setup(prefix: string) {
  const ledger = new FakeLedger();
  const sender = new FakeSender(ledger);
  const signer = new FakeSigner();
  const config = { ...LAUNCH_ENGINE, confirmPollMs: 5, confirmWaitMs: 2_000, pausedRetryMs: 50 };
  const engine = new LaunchEngine({
    db,
    chain: ledger,
    signer,
    sender,
    cluster: "devnet",
    stonkfun: new StaticStonkFunAdapter(),
    config,
    metadataUri: (id) => `https://api.test/${id}`,
  });
  const queue = createLaunchQueue(redis, prefix);
  const start = () =>
    createLaunchWorker({ connection: redis, engine, db, concurrency: 1, logger: silent, prefix });
  return { ledger, sender, signer, engine, queue, start, config };
}

async function waitFor(fn: () => Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timeout menunggu kondisi");
}

const statusOf = async (id: string) =>
  (await db.launchJob.findUniqueOrThrow({ where: { id } })).status;

describe("queue launch (BullMQ)", () => {
  it("job yang diantrekan diproses sampai live; enqueue ganda tidak menduplikasi", async () => {
    const t = setup(`test-${Date.now()}-a`);
    const job = await seed();
    await enqueueLaunch(t.queue, job.id, t.config);
    await enqueueLaunch(t.queue, job.id, t.config);
    const worker = t.start();
    await waitFor(async () => (await statusOf(job.id)) === "live");
    expect(t.signer.signed).toBe(1);
    expect(t.ledger.createsLanded).toBe(1);
    await worker.close();
    await t.queue.obliterate({ force: true });
    await t.queue.close();
  });

  it("worker restart di tengah job (transaksi terkirim, belum terkonfirmasi) → worker baru menyelesaikan tanpa kirim ulang", async () => {
    const t = setup(`test-${Date.now()}-b`);
    t.sender.behaviors = ["drop"]; // belum mendarat saat worker pertama mati
    t.ledger.validity = 1_000_000_000;
    const job = await seed();
    await enqueueLaunch(t.queue, job.id, t.config);
    const first = t.start();
    await waitFor(async () => (await statusOf(job.id)) === "confirming");
    await first.close(true); // matikan paksa (tanpa menunggu job aktif selesai)
    expect(t.sender.sent).toBe(1);

    // Transaksi yang tadi terkirim akhirnya mendarat; worker baru + sweeper mengambil job.
    const tx = await db.transaction.findFirstOrThrow({ where: { jobId: job.id } });
    t.ledger.statuses.set(tx.signature, { slot: 1, err: null, confirmationStatus: "confirmed" });
    t.ledger.mints.set(
      (await db.launchJob.findUniqueOrThrow({ where: { id: job.id } })).mintAddress!,
      {
        pool: "pool-x",
        signature: tx.signature,
      },
    );
    const second = t.start();
    await sweepStaleLaunches(db, t.queue, { ...t.config, staleAfterMs: 0 });
    await waitFor(async () => (await statusOf(job.id)) === "live");
    expect(t.sender.sent).toBe(1);
    expect(t.signer.signed).toBe(1);
    await second.close();
    await t.queue.obliterate({ force: true });
    await t.queue.close();
  });

  it("sweeper mengantrekan job non-final yang macet, bukan job final", async () => {
    const t = setup(`test-${Date.now()}-c`);
    const stuck = await seed("queued");
    const live = await seed("queued");
    await db.launchJob.update({ where: { id: live.id }, data: { status: "live" } });
    const ids = await sweepStaleLaunches(db, t.queue, { ...t.config, staleAfterMs: 0 });
    expect(ids).toEqual([stuck.id]);
    expect(await t.queue.getJob(stuck.id)).toBeTruthy();
    await t.queue.obliterate({ force: true });
    await t.queue.close();
  });

  it("percobaan habis saat confirming → needs_reconciliation; queued tanpa transaksi tidak diubah", async () => {
    const confirming = await seed("confirming");
    await db.transaction.create({
      data: { signature: `s${Date.now()}`, jobId: confirming.id, type: "create" },
    });
    await flagForReconciliation(db, confirming.id, "RPC timeout");
    expect(await statusOf(confirming.id)).toBe("needs_reconciliation");
    const queued = await seed("queued");
    await flagForReconciliation(db, queued.id, "x");
    expect(await statusOf(queued.id)).toBe("queued");
  });
});
