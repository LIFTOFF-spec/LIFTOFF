/**
 * Economic engine di API (Tahap 7): Section 2 dashboard token & reserve dari ledger nyata;
 * fee yang belum di-claim tidak pernah dihitung sebagai dana diterima (Spec Rule 9).
 */
import { randomUUID } from "node:crypto";
import { recordTradeAndCreatorFee } from "@liftoff/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeApp, newWallet, resetDb } from "./test-helpers";

type Ctx = Awaited<ReturnType<typeof makeApp>>;
let ctx: Ctx;
beforeAll(async () => {
  ctx = await makeApp();
}, 120_000);
afterAll(() => ctx.app.close());
beforeEach(() => resetDb(ctx.db));

const WSOL = "So11111111111111111111111111111111111111112";

async function seed() {
  const mint = newWallet().address;
  const user = await ctx.db.user.create({ data: { wallet: newWallet().address } });
  await ctx.db.token.create({
    data: {
      name: "Eco",
      ticker: "ECO",
      tickerNormalized: "eco",
      mint,
      quoteMint: WSOL,
      quoteConfigId: "7ZR4zD7PYfY2XxoG1Gxcy2EgEeGYrpxrwzPuwdUBssEt",
      creatorUserId: user.id,
      launchStatus: "live",
    },
  });
  const trade = async (fee: string) => {
    const signature = `sig-${randomUUID()}`;
    await recordTradeAndCreatorFee(
      ctx.db,
      {
        signature,
        route: "launchlab",
        side: "buy",
        mint,
        wallet: "w",
        amountIn: "1000",
        amountOut: "1",
        slot: 1,
        fees: [
          { kind: "creator", label: "c", rate: 5000, amount: fee, mint: WSOL, recipient: "m" },
        ],
      },
      WSOL,
    );
    return signature;
  };
  return { mint, trade };
}

describe("economic engine di API", () => {
  it("Section 2 & reserve: hanya fee yang sudah di-claim dihitung; sisanya 'awaiting claim'", async () => {
    const { mint, trade } = await seed();
    const claimedSig = await trade("20000");
    await trade("10000"); // belum di-claim
    const claim = await ctx.db.economicOp.create({
      data: {
        kind: "claim_curve",
        status: "confirmed",
        target: `vault-${randomUUID()}`,
        assetMint: WSOL,
        idempotencyKey: randomUUID(),
        signature: `claim-${randomUUID()}`,
        amountOut: 20000,
        confirmedAt: new Date(),
      },
    });
    const received = await ctx.db.feeLedger.findFirstOrThrow({
      where: { sourceSignature: claimedSig, entryType: "received" },
    });
    await ctx.db.feeClaimItem.create({ data: { feeLedgerId: received.id, claimOpId: claim.id } });
    await ctx.db.feeReconciliation.create({
      data: {
        claimOpId: claim.id,
        assetMint: WSOL,
        claimedRaw: 20000,
        ledgerRaw: 20000,
        differenceRaw: 0,
        status: "verified",
        tokens: [{ tokenMint: mint, ledgerRaw: "20000", correctionRaw: "0" }],
      },
    });

    const res = await ctx.app.inject({ method: "GET", url: `/api/tokens/${mint}/ledger` });
    expect(res.statusCode).toBe(200);
    const { economics, reserveState } = res.json().data;
    expect(economics.feesAllocated).toMatchObject({ value: "0.000016", status: "verified" });
    expect(economics.allocationAwaitingClaim).toMatchObject({
      value: "0.000008",
      status: "delayed",
    });
    expect(economics.budgetAvailable.value).toBe("0.000016");
    expect(economics.claims).toHaveLength(1);
    expect(economics.claims[0]).toMatchObject({ status: "verified", signature: claim.signature });
    expect(reserveState.balance.value).toBe("0.000004");
    expect(reserveState.awaitingClaim).toMatchObject({ value: "0.000002", status: "delayed" });

    const t = await ctx.app.inject({ method: "GET", url: "/api/transparency" });
    expect(t.json().data.economic.claims.some((c: { id: string }) => c.id === claim.id)).toBe(true);
  });

  it("GET /api/health/economic: alert saat worker gagal berulang", async () => {
    await ctx.db.workerHeartbeat.upsert({
      where: { name: "economic:buyback" },
      create: {
        name: "economic:buyback",
        lastRunAt: new Date(),
        consecutiveFailures: 4,
        lastError: "rpc",
      },
      update: { lastRunAt: new Date(), consecutiveFailures: 4, lastError: "rpc" },
    });
    const res = await ctx.app.inject({ method: "GET", url: "/api/health/economic" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: "degraded" });
    expect(res.json().alerts.map((a: { code: string }) => a.code)).toContain("worker_failing");
  });

  it("GET /api/health/status: satu ringkasan, error worker tanpa URL/API key", async () => {
    const leak = "fetch failed https://devnet.helius-rpc.com/?api-key=SECRETKEY123";
    await ctx.db.workerHeartbeat.upsert({
      where: { name: "economic:reserve" },
      create: {
        name: "economic:reserve",
        lastRunAt: new Date(),
        consecutiveFailures: 5,
        lastError: leak,
      },
      update: { lastRunAt: new Date(), consecutiveFailures: 5, lastError: leak },
    });
    await ctx.db.systemFlag.upsert({
      where: { key: "signer.paused" },
      create: { key: "signer.paused", value: { paused: true, reason: "drill" }, updatedBy: "test" },
      update: { value: { paused: true, reason: "drill" } },
    });
    const res = await ctx.app.inject({ method: "GET", url: "/api/health/status" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body).toMatchObject({
      status: "degraded",
      checks: { db: "ok", redis: "ok", rpc: "ok", signer: "not_configured" },
      signer: { paused: true },
    });
    const codes = body.alerts.map((a: { code: string }) => a.code);
    expect(codes).toEqual(expect.arrayContaining(["worker_failing", "signer_paused"]));
    expect(res.body).not.toContain("SECRETKEY123");
    expect(res.body).not.toContain("helius");
    const eco = await ctx.app.inject({ method: "GET", url: "/api/health/economic" });
    expect(eco.body).not.toContain("SECRETKEY123");
    await ctx.db.systemFlag.delete({ where: { key: "signer.paused" } });
  });

  it("GET /api/health/status: indexer tertinggal → critical", async () => {
    await ctx.db.workerHeartbeat.deleteMany({});
    const user = await ctx.db.user.create({ data: { wallet: `w${Date.now()}` } });
    await ctx.db.token.create({
      data: {
        name: "Lag",
        ticker: "LAG",
        tickerNormalized: `lag${Date.now()}`,
        mint: `LagMint${Date.now()}`,
        quoteMint: "So11111111111111111111111111111111111111112",
        quoteConfigId: "cfg",
        creatorUserId: user.id,
        launchStatus: "live",
      },
    });
    const res = await ctx.app.inject({ method: "GET", url: "/api/health/status" });
    expect(res.json().alerts.map((a: { code: string }) => a.code)).toContain("indexer_lagging");
    expect(res.json().indexer).toMatchObject({ lastIndexedAt: null });
  });
});
