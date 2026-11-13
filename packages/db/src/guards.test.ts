/**
 * Aturan yang ditegakkan DATABASE (bukan kode aplikasi):
 *  - ledger append-only (Aturan #7): UPDATE / DELETE / TRUNCATE gagal;
 *  - satu klaim aktif per akun X (concurrency); ticker berulang boleh (Spec §7, indikator risiko).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { base58Encode } from "@liftoff/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, type Db } from "./index";
import { prepareTestDatabase } from "./testing";

let db: Db;

beforeAll(async () => {
  db = createPrismaClient(await prepareTestDatabase("liftoff_test_db"));
}, 120_000);

afterAll(async () => {
  await db?.$disconnect();
});

const mint = () => `mint-${randomUUID()}`;

describe("ledger append-only", () => {
  it("fee_ledger: INSERT boleh, UPDATE/DELETE/TRUNCATE ditolak", async () => {
    const row = await db.feeLedger.create({
      data: {
        sourceSignature: `sig-${randomUUID()}`,
        tokenMint: mint(),
        amount: "1000000",
        assetMint: "So11111111111111111111111111111111111111112",
        entryType: "received",
        attribution: "verified",
      },
    });
    await expect(
      db.feeLedger.update({ where: { id: row.id }, data: { amount: "1" } }),
    ).rejects.toThrow(/append-only/);
    await expect(db.feeLedger.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
    await expect(db.$executeRawUnsafe(`UPDATE "fee_ledger" SET "amount" = 0`)).rejects.toThrow(
      /append-only/,
    );
    await expect(db.$executeRawUnsafe(`DELETE FROM "fee_ledger"`)).rejects.toThrow(/append-only/);
    // Sejak Tahap 7 fee_claim_items merujuk fee_ledger: TRUNCATE sudah ditolak FK sebelum trigger.
    await expect(db.$executeRawUnsafe(`TRUNCATE "fee_ledger"`)).rejects.toThrow(
      /append-only|foreign key/,
    );

    const after = await db.feeLedger.findUnique({ where: { id: row.id } });
    expect(after?.amount.toString()).toBe("1000000");
  });

  it("burn_ledger, reserve_ledger, reserve_decisions, audit_events juga append-only", async () => {
    const tokenMint = mint();
    const burn = await db.burnLedger.create({
      data: {
        tokenMint,
        amountBurned: "18521402319433",
        amountSpent: "20000000",
        assetMint: "So11111111111111111111111111111111111111112",
        buybackSignature: `bb-${randomUUID()}`,
        burnSignature: `burn-${randomUUID()}`,
      },
    });
    const reserve = await db.reserveLedger.create({
      data: {
        tokenMint,
        entryType: "deployment",
        amount: "500",
        assetMint: "So11111111111111111111111111111111111111112",
        txSignature: `tx-${randomUUID()}`,
      },
    });
    const decision = await db.reserveDecision.create({
      data: { tokenMint, allowed: false, amount: "0", reasons: ["cooldown"], inputSnapshot: {} },
    });
    const audit = await db.auditEvent.create({
      data: { actor: "test", action: "test.append_only", result: "ok" },
    });

    await expect(
      db.burnLedger.update({ where: { id: burn.id }, data: { amountBurned: "0" } }),
    ).rejects.toThrow(/append-only/);
    await expect(db.burnLedger.delete({ where: { id: burn.id } })).rejects.toThrow(/append-only/);
    await expect(
      db.reserveLedger.update({ where: { id: reserve.id }, data: { amount: "0" } }),
    ).rejects.toThrow(/append-only/);
    await expect(db.reserveLedger.delete({ where: { id: reserve.id } })).rejects.toThrow(
      /append-only/,
    );
    await expect(
      db.reserveDecision.update({ where: { id: decision.id }, data: { allowed: true } }),
    ).rejects.toThrow(/append-only/);
    await expect(db.auditEvent.delete({ where: { id: audit.id } })).rejects.toThrow(/append-only/);
    for (const table of ["burn_ledger", "reserve_ledger", "reserve_decisions", "audit_events"]) {
      await expect(db.$executeRawUnsafe(`TRUNCATE "${table}"`)).rejects.toThrow(/append-only/);
    }
  });

  it("koreksi lewat entri baru; nominal negatif hanya untuk correction", async () => {
    const tokenMint = mint();
    const base = {
      sourceSignature: `sig-${randomUUID()}`,
      tokenMint,
      assetMint: "So11111111111111111111111111111111111111112",
      attribution: "verified" as const,
    };
    await expect(
      db.feeLedger.create({ data: { ...base, amount: "-5", entryType: "received" } }),
    ).rejects.toThrow();
    await db.feeLedger.create({ data: { ...base, amount: "100", entryType: "received" } });
    await db.feeLedger.create({ data: { ...base, amount: "-5", entryType: "correction" } });
    const sum = await db.feeLedger.aggregate({ where: { tokenMint }, _sum: { amount: true } });
    expect(sum._sum.amount?.toString()).toBe("95");
  });
});

describe("partial unique index klaim aktif", () => {
  async function makeToken(tickerNormalized: string) {
    const user = await db.user.create({ data: { wallet: base58Encode(randomBytes(32)) } });
    return db.token.create({
      data: {
        name: "T",
        ticker: tickerNormalized.toUpperCase(),
        tickerNormalized,
        quoteMint: "So11111111111111111111111111111111111111112",
        quoteConfigId: "cfg",
        creatorUserId: user.id,
      },
    });
  }

  it("Spec §7: ticker yang sama boleh punya beberapa klaim aktif (bukan penipuan otomatis)", async () => {
    const ticker = `t${randomUUID().slice(0, 8)}`;
    const tokens = await Promise.all(Array.from({ length: 3 }, () => makeToken(ticker)));
    const results = await Promise.allSettled(
      tokens.map((t) =>
        db.tickerClaim.create({ data: { tickerNormalized: ticker, tokenId: t.id } }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
  });

  it("klaim yang sudah released tidak memblokir klaim baru", async () => {
    const ticker = `t${randomUUID().slice(0, 8)}`;
    const [a, b] = await Promise.all([makeToken(ticker), makeToken(ticker)]);
    await db.tickerClaim.create({
      data: { tickerNormalized: ticker, tokenId: a.id, status: "released" },
    });
    await expect(
      db.tickerClaim.create({ data: { tickerNormalized: ticker, tokenId: b.id } }),
    ).resolves.toBeTruthy();
  });

  it("satu akun X hanya boleh punya satu klaim aktif", async () => {
    const xUserId = `x-${randomUUID()}`;
    const [a, b] = await Promise.all([makeToken("aaa"), makeToken("bbb")]);
    const results = await Promise.allSettled([
      db.xAccountClaim.create({ data: { xUserId, tokenId: a.id } }),
      db.xAccountClaim.create({ data: { xUserId, tokenId: b.id } }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});
