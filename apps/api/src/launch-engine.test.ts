/**
 * Tahap 4 di sisi API: job diantrekan ke BullMQ setelah dibuat, status/mint/signature mengikuti
 * DB, deposit launch opsional, dan metadata token untuk URI on-chain.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { launchBody, makeApp, resetDb, walletLogin, type TestSession } from "./test-helpers";

type Ctx = Awaited<ReturnType<typeof makeApp>>;
let ctx: Ctx;

beforeAll(async () => {
  ctx = await makeApp();
}, 120_000);
afterAll(() => ctx.app.close());
beforeEach(async () => {
  await resetDb(ctx.db);
  ctx.launchQueue.jobs.length = 0;
  ctx.launchQueue.fail = false;
});

const SIG = "5".repeat(87);

async function launch(
  s: Pick<TestSession, "cookie" | "ip">,
  body: Record<string, unknown>,
  key = randomUUID(),
  app = ctx.app,
) {
  return app.inject({
    method: "POST",
    url: "/api/launch",
    headers: { cookie: s.cookie, "idempotency-key": key },
    payload: body,
    remoteAddress: s.ip,
  });
}

describe("POST /api/launch → queue launch", () => {
  it("job baru diantrekan sekali; replay idempotent tidak mengantre ulang", async () => {
    const s = await walletLogin(ctx.app);
    const key = randomUUID();
    const res = await launch(s, launchBody({ ticker: "QUEUE" }), key);
    expect(res.statusCode).toBe(201);
    const job = res.json();
    expect(job).toMatchObject({ status: "queued", mint: null, signature: null, sendMode: null });
    expect(ctx.launchQueue.jobs).toEqual([job.id]);
    const again = await launch(s, launchBody({ ticker: "QUEUE" }), key);
    expect(again.statusCode).toBe(200);
    expect(ctx.launchQueue.jobs).toEqual([job.id]);
  });

  it("Redis mati saat enqueue → job tetap dibuat (201, queued) untuk diambil sweeper", async () => {
    ctx.launchQueue.fail = true;
    const s = await walletLogin(ctx.app);
    const res = await launch(s, launchBody({ ticker: "NOREDIS" }));
    expect(res.statusCode).toBe(201);
    const row = await ctx.db.launchJob.findUnique({ where: { id: res.json().id } });
    expect(row?.status).toBe("queued");
  });

  it("GET /api/launch/:id: mint & signature hanya setelah live (P5)", async () => {
    const s = await walletLogin(ctx.app);
    const created = (await launch(s, launchBody({ ticker: "SECRET" }))).json();
    const mint = "So11111111111111111111111111111111111111112";
    await ctx.db.launchJob.update({
      where: { id: created.id },
      data: { status: "confirming", mintAddress: mint, createSignature: SIG },
    });
    await ctx.db.transaction.create({
      data: { signature: SIG, jobId: created.id, type: "create", sendMode: "rpc" },
    });
    await ctx.db.token.update({
      where: { id: created.tokenId },
      data: { launchStatus: "confirming" },
    });
    let got = (await ctx.app.inject({ method: "GET", url: `/api/launch/${created.id}` })).json();
    expect(got).toMatchObject({
      status: "confirming",
      mint: null,
      signature: null,
      sendMode: "rpc",
    });
    expect(JSON.stringify(got)).not.toContain(mint);

    await ctx.db.launchJob.update({ where: { id: created.id }, data: { status: "live" } });
    await ctx.db.token.update({
      where: { id: created.tokenId },
      data: { launchStatus: "live", mint },
    });
    got = (await ctx.app.inject({ method: "GET", url: `/api/launch/${created.id}` })).json();
    expect(got).toMatchObject({ status: "live", mint, signature: SIG });
  });

  it("metadata token untuk URI on-chain, tanpa alamat mint", async () => {
    const s = await walletLogin(ctx.app);
    const created = (
      await launch(
        s,
        launchBody({ ticker: "META", description: "hello", website: "https://x.example" }),
      )
    ).json();
    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/metadata/${created.tokenId}.json`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      name: "Test Coin",
      symbol: "META",
      description: "hello",
      external_url: "https://x.example",
    });
    expect(
      (await ctx.app.inject({ method: "GET", url: "/api/metadata/nope.json" })).statusCode,
    ).toBe(404);
  });
});

describe("deposit launch (LAUNCH_DEPOSIT_ENABLED=1)", () => {
  it("wajib signature deposit; deposit tidak valid ditolak; satu deposit = satu launch", async () => {
    const app = await makeApp({
      config: { launchDeposit: { enabled: true, lamports: 100_000_000 } },
      deposit: (sig) =>
        sig.startsWith("4")
          ? { ok: false, reason: "Deposit transaction not found." }
          : { ok: true, lamports: 100_000_000n },
    });
    try {
      const s = await walletLogin(app.app);
      const missing = await launch(s, launchBody({ ticker: "DEPA" }), randomUUID(), app.app);
      expect(missing.statusCode).toBe(402);
      expect(missing.json().error.code).toBe("launch_deposit_required");

      const bad = await launch(
        s,
        { ...launchBody({ ticker: "DEPB" }), depositSignature: "4".repeat(87) },
        randomUUID(),
        app.app,
      );
      expect(bad.statusCode).toBe(422);
      expect(bad.json().error.code).toBe("launch_deposit_invalid");

      const ok = await launch(
        s,
        { ...launchBody({ ticker: "DEPC" }), depositSignature: SIG },
        randomUUID(),
        app.app,
      );
      expect(ok.statusCode).toBe(201);
      const dep = await app.db.launchDeposit.findUnique({ where: { jobId: ok.json().id } });
      expect(dep).toMatchObject({
        payer: s.wallet.address,
        status: "received",
        depositSignature: SIG,
      });
      // UI menampilkan status biaya launch (disimpan / dikembalikan) dari respons job.
      expect(ok.json().deposit).toEqual({
        lamports: "100000000",
        signature: SIG,
        status: "received",
        refundSignature: null,
      });
      const polled = await app.app.inject({ method: "GET", url: `/api/launch/${ok.json().id}` });
      expect(polled.json().deposit).toMatchObject({ signature: SIG, status: "received" });
      expect(app.launchQueue.jobs).toEqual([ok.json().id]);

      // Wallet kedua mencoba memakai signature deposit yang sama.
      const s2 = await walletLogin(app.app);
      const reuse = await launch(
        s2,
        { ...launchBody({ ticker: "DEPD" }), depositSignature: SIG },
        randomUUID(),
        app.app,
      );
      expect(reuse.statusCode).toBe(409);
      expect(reuse.json().error.code).toBe("launch_deposit_reused");
    } finally {
      await app.app.close();
    }
  });
});
