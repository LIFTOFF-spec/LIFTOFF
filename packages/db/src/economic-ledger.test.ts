/**
 * Akuntansi economic engine (Tahap 7): fungsi murni rekonsiliasi + aturan DB economic_ops
 * (satu operasi aktif per target, confirmed final, tidak bisa dihapus, burn sekali per buyback).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPrismaClient,
  distributeProRata,
  planReconciliation,
  type ClaimCandidate,
  type Db,
} from "./index";
import { prepareTestDatabase } from "./testing";

let db: Db;
beforeAll(async () => {
  db = createPrismaClient(await prepareTestDatabase("liftoff_test_db"));
});
afterAll(async () => {
  await db.$disconnect();
});

const c = (tokenMint: string, amount: bigint, slot: bigint): ClaimCandidate => ({
  feeLedgerId: randomUUID(),
  tokenMint,
  amount,
  slot,
});

describe("distributeProRata", () => {
  it("jumlah persis sama dengan total, termasuk negatif", () => {
    const w = new Map([
      ["a", 3n],
      ["b", 1n],
      ["c", 1n],
    ]);
    for (const total of [7n, -7n, 1n, 1000n]) {
      const out = distributeProRata(total, w);
      expect([...out.values()].reduce((s, v) => s + v, 0n)).toBe(total);
    }
    expect(
      distributeProRata(
        -4000n,
        new Map([
          ["a", 30n],
          ["b", 10n],
        ]),
      ),
    ).toEqual(
      new Map([
        ["a", -3000n],
        ["b", -1000n],
      ]),
    );
  });
});

describe("planReconciliation", () => {
  const base = { claimSlot: 100n, ageMs: 0, graceMs: 60_000 };
  it("tanpa entri received: dibagi menurut volume; tanpa volume: ditahan", () => {
    const late = { ...base, ageMs: 60_000, claimed: 100n, candidates: [] };
    const byVolume = planReconciliation({
      ...late,
      volumeWeights: new Map([
        ["a", 3n],
        ["b", 1n],
        ["c", 0n],
      ]),
    });
    expect(byVolume).toMatchObject({ status: "estimated", ledgerRaw: 0n, unattributedRaw: 0n });
    expect(byVolume.action === "reconcile" && [...byVolume.corrections].sort()).toEqual([
      ["a", 75n],
      ["b", 25n],
    ]);
    expect(planReconciliation({ ...late, volumeWeights: new Map() })).toMatchObject({
      status: "estimated",
      unattributedRaw: 100n,
    });
    expect(
      planReconciliation({ ...late, ageMs: 0, volumeWeights: new Map([["a", 1n]]) }),
    ).toMatchObject({ action: "wait" });
  });
  it("cocok persis → verified", () => {
    const p = planReconciliation({
      ...base,
      claimed: 30n,
      candidates: [c("a", 10n, 50n), c("b", 20n, 99n)],
    });
    expect(p).toMatchObject({
      action: "reconcile",
      status: "verified",
      ledgerRaw: 30n,
      differenceRaw: 0n,
    });
  });
  it("trade di slot claim yang terjadi sesudah claim tidak dihitung", () => {
    const p = planReconciliation({
      ...base,
      claimed: 10n,
      candidates: [c("a", 10n, 50n), c("a", 5n, 100n)],
    });
    expect(p).toMatchObject({ action: "reconcile", status: "verified", ledgerRaw: 10n });
    if (p.action === "reconcile") expect(p.link).toHaveLength(1);
  });
  it("selisih sebelum masa tunggu → wait; sesudahnya → estimated + koreksi pro-rata", () => {
    const cands = [c("a", 30n, 50n), c("b", 10n, 60n)];
    expect(planReconciliation({ ...base, claimed: 36n, candidates: cands }).action).toBe("wait");
    const p = planReconciliation({ ...base, ageMs: 60_001, claimed: 36n, candidates: cands });
    expect(p).toMatchObject({ action: "reconcile", status: "estimated", differenceRaw: -4n });
    if (p.action === "reconcile") {
      expect([...p.corrections.values()].reduce((s, v) => s + v, 0n)).toBe(-4n);
    }
  });
  it("surplus tanpa trade teratribusi → ditahan (unattributed), tidak dibagi ke token", () => {
    const p = planReconciliation({ ...base, ageMs: 60_001, claimed: 500n, candidates: [] });
    expect(p).toMatchObject({ action: "reconcile", status: "estimated", unattributedRaw: 500n });
    if (p.action === "reconcile") expect(p.corrections.size).toBe(0);
  });
});

describe("economic_ops — aturan DB", () => {
  const op = (target: string, extra: Record<string, unknown> = {}) =>
    db.economicOp.create({
      data: {
        kind: "buyback",
        target,
        assetMint: "So11111111111111111111111111111111111111112",
        tokenMint: target,
        idempotencyKey: `buyback:${target}:${randomUUID()}`,
        amountIn: 1000,
        ...extra,
      },
    });

  it("satu operasi aktif per (jenis, target); boleh lagi setelah gagal", async () => {
    const t = `mint-${randomUUID()}`;
    const first = await op(t);
    await expect(op(t)).rejects.toThrow();
    await db.economicOp.update({ where: { id: first.id }, data: { status: "failed" } });
    await expect(op(t)).resolves.toBeTruthy();
  });

  it("confirmed final: status & nominal tidak bisa diubah; tidak bisa dihapus", async () => {
    const t = `mint-${randomUUID()}`;
    const o = await op(t, { status: "confirmed", signature: `sig-${randomUUID()}`, amountOut: 5 });
    await expect(
      db.economicOp.update({ where: { id: o.id }, data: { status: "failed" } }),
    ).rejects.toThrow(/final/);
    await expect(
      db.economicOp.update({ where: { id: o.id }, data: { amountOut: 6 } }),
    ).rejects.toThrow(/final/);
    await expect(
      db.economicOp.update({ where: { id: o.id }, data: { details: { note: "ok" } } }),
    ).resolves.toBeTruthy();
    await expect(db.economicOp.delete({ where: { id: o.id } })).rejects.toThrow(/append-only/);
  });

  it("satu buyback hanya dibakar sekali", async () => {
    const t = `mint-${randomUUID()}`;
    const parent = await op(t, {
      status: "confirmed",
      signature: `sig-${randomUUID()}`,
      amountOut: 5,
    });
    const burn = (n: number) =>
      db.economicOp.create({
        data: {
          kind: "burn",
          target: `ata-${t}-${n}`,
          assetMint: t,
          tokenMint: t,
          idempotencyKey: `burn:${t}:${n}`,
          amountIn: 5,
          parentOpId: parent.id,
        },
      });
    await burn(1);
    await expect(burn(2)).rejects.toThrow();
  });

  it("fee_claim_items & fee_reconciliations append-only", async () => {
    for (const table of ["fee_claim_items", "fee_reconciliations"]) {
      // UPDATE/DELETE: trigger per baris (diuji lewat engine); TRUNCATE: trigger per statement.
      await expect(db.$executeRawUnsafe(`TRUNCATE "${table}"`)).rejects.toThrow(/append-only/);
    }
  });
});
