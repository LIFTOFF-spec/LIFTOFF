import { createPrismaClient, recordTradeAndCreatorFee, type Db, saveQuoteAsset } from "@liftoff/db";
import { prepareTestDatabase, RESETTABLE_TABLES } from "@liftoff/db/testing";
import { INDEXER_CONFIG, pairsFor, platformFor, raydiumAuthoritiesFor } from "@liftoff/shared";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cpmmPool,
  curveEvent,
  FakeIndexerChain,
  launchPool,
  parsedTx,
  PROGRAMS,
  swapEvent,
  uniqueSig,
} from "./fakes";
import { MarketIndexer } from "./indexer";

const SOL = pairsFor("devnet").find((p) => p.id === "sol")!;
const MASTER = platformFor("devnet").masterWallet;
const silent = { info: () => {}, warn: () => {} };
let db: Db;

beforeAll(async () => {
  db = createPrismaClient(await prepareTestDatabase("liftoff_test_worker"));
});
beforeEach(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE ${RESETTABLE_TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
});
afterAll(async () => {
  await db.$disconnect();
});

/** Mint unik per test (ledger append-only tidak dikosongkan antar test). */
async function seedToken() {
  const mint = uniqueSig("mint");
  const user = await db.user.create({ data: { wallet: uniqueSig("wallet") } });
  await db.token.create({
    data: {
      name: "Indexed",
      ticker: "IDX",
      tickerNormalized: "idx",
      mint,
      quoteMint: SOL.mint,
      quoteConfigId: SOL.configId,
      creatorUserId: user.id,
      launchStatus: "live",
    },
  });
  return mint;
}

function setup(mint: string) {
  const chain = new FakeIndexerChain();
  const curve = chain.launchPoolAddress(mint);
  chain.launchPools.set(curve, launchPool(curve, mint, SOL.mint, MASTER));
  chain.supplies.set(mint, 1_000_000_000_000_000n);
  chain.accounts.set(mint, [
    { address: "a1", owner: "HolderOne", amount: 5n },
    { address: "a2", owner: "HolderTwo", amount: 7n },
    { address: "a3", owner: "5xqNaZXX5eUi4p5HU4oz9i5QnwRNT2y6oN7yyn4qENeq", amount: 9n }, // vault
  ]);
  // Transaksi create (tanpa event trade) lalu satu buy di luar UI LIFTOFF.
  chain.push([curve], parsedTx(uniqueSig("create")));
  const buy = chain.push([curve], parsedTx(uniqueSig("buy"), { launchlab: [curveEvent(curve)] }));
  return { chain, curve, buy };
}

const indexerFor = (chain: FakeIndexerChain, now?: () => Date) =>
  new MarketIndexer({
    db,
    chain,
    cluster: "devnet",
    masterWallet: MASTER,
    config: { ...INDEXER_CONFIG, signaturePageLimit: 2 },
    logger: silent,
    ...(now ? { now } : {}),
  });

async function ledgerFor(signature: string) {
  return {
    receipts: await db.tradeReceipt.findMany({ where: { signature } }),
    fees: await db.feeLedger.findMany({
      where: { sourceSignature: signature },
      orderBy: { entryType: "asc" },
    }),
    reserve: await db.reserveLedger.findMany({ where: { txSignature: signature } }),
  };
}

describe("MarketIndexer", () => {
  it("trade di luar UI tercatat + creator fee 80/20; restart tidak menghasilkan entri ganda", async () => {
    const mint = await seedToken();
    const { chain, curve, buy } = setup(mint);

    const r1 = await indexerFor(chain).runCycle();
    expect(r1).toMatchObject({ failed: 0, recorded: 1 });
    const l1 = await ledgerFor(buy);
    expect(l1.receipts).toHaveLength(1);
    expect(l1.receipts[0]).toMatchObject({
      recordedBy: "indexer",
      side: "buy",
      route: "launchlab",
      tokenMint: mint,
    });
    expect(l1.receipts[0]!.amountQuote.toFixed(0)).toBe("4000000");
    expect(l1.receipts[0]!.priceQuote).not.toBeNull();
    expect(l1.fees.map((f) => [f.entryType, f.amount.toFixed(0)])).toEqual([
      ["received", "20000"],
      ["allocated_buyback", "16000"],
      ["allocated_reserve", "4000"],
    ]);
    expect(l1.reserve.map((r) => r.amount.toFixed(0))).toEqual(["4000"]);

    // "Restart": instance baru, checkpoint dari DB → tidak ada yang dicatat ulang.
    const r2 = await indexerFor(chain).runCycle();
    expect(r2.recorded).toBe(0);
    const l2 = await ledgerFor(buy);
    expect([l2.receipts.length, l2.fees.length, l2.reserve.length]).toEqual([1, 3, 1]);

    // Trade baru sesudah checkpoint: hanya itu yang diproses.
    const sell = chain.push(
      [curve],
      parsedTx(uniqueSig("sell"), {
        launchlab: [curveEvent(curve, { direction: 1, creatorFee: 9_825n })],
      }),
    );
    const before = await db.indexerCheckpoint.findUniqueOrThrow({ where: { address: curve } });
    await indexerFor(chain).runCycle();
    const after = await db.indexerCheckpoint.findUniqueOrThrow({ where: { address: curve } });
    expect(after.lastSignature).toBe(sell);
    expect(after.processed - before.processed).toBe(1);
    expect((await ledgerFor(sell)).fees.map((f) => f.amount.toFixed(0))).toEqual([
      "9825",
      "7860",
      "1965",
    ]);
  });

  it("quote di luar registri: desimal dari katalog; tak dikenal tidak ditebak dan dicoba lagi", async () => {
    const quote = uniqueSig("quote");
    const mint = await seedToken();
    await db.token.update({
      where: { mint },
      data: { quoteMint: quote, quoteConfigId: "CfgLain" },
    });
    const { chain, buy } = setup(mint);

    expect(await indexerFor(chain).runCycle()).toMatchObject({ failed: 1, recorded: 0 });
    expect((await ledgerFor(buy)).receipts).toHaveLength(0);

    await saveQuoteAsset(db, "devnet", {
      mint: quote,
      symbol: "ABC",
      name: "Abc",
      decimals: 6,
      raiseRaw: "8000000000",
    });
    expect(await indexerFor(chain).runCycle()).toMatchObject({ failed: 0, recorded: 1 });
    const l = await ledgerFor(buy);
    expect(l.receipts[0]).toMatchObject({ tokenMint: mint, quoteMint: quote });
    // Harga = quote per token: dengan quote 6 desimal, 1000× harga quote 9 desimal yang sama.
    const solMint = await seedToken();
    const sol = setup(solMint);
    await indexerFor(sol.chain).runCycle();
    const solPrice = (await ledgerFor(sol.buy)).receipts[0]!.priceQuote!;
    expect(l.receipts[0]!.priceQuote!.toNumber() / solPrice.toNumber()).toBeCloseTo(1000, 3);
  });

  it("trade yang lebih dulu dicatat API tidak dicatat dua kali; indexer melengkapi harga", async () => {
    const mint = await seedToken();
    const { chain, buy } = setup(mint);
    await recordTradeAndCreatorFee(
      db,
      {
        signature: buy,
        route: "launchlab",
        side: "buy",
        mint,
        wallet: "OutsideTrader1111111111111111111111111111111",
        amountIn: "4000000",
        amountOut: "150000000000",
        slot: 1,
        fees: [
          {
            kind: "creator",
            label: "Creator fee",
            rate: 5000,
            amount: "20000",
            mint: SOL.mint,
            recipient: MASTER,
          },
        ],
      },
      SOL.mint,
    );
    await indexerFor(chain).runCycle();
    const l = await ledgerFor(buy);
    expect(l.receipts).toHaveLength(1);
    expect(l.receipts[0]!.recordedBy).toBe("api");
    expect(l.receipts[0]!.priceQuote).not.toBeNull();
    expect(l.fees).toHaveLength(3);
    expect(l.reserve).toHaveLength(1);
  });

  it("error RPC: checkpoint tidak maju, siklus dilempar (backoff), lalu lanjut setelah pulih", async () => {
    const mint = await seedToken();
    const { chain, curve, buy } = setup(mint);
    chain.txs.set(buy, new Error("429 Too Many Requests"));
    await expect(indexerFor(chain).runCycle()).rejects.toThrow(/429/);
    const cp = await db.indexerCheckpoint.findUniqueOrThrow({ where: { address: curve } });
    expect(cp.lastSignature).not.toBe(buy);
    expect(cp.errorCount).toBe(1);

    chain.txs.set(buy, parsedTx(buy, { launchlab: [curveEvent(curve)] }));
    await indexerFor(chain).runCycle();
    expect((await ledgerFor(buy)).fees).toHaveLength(3);
    const ok = await db.indexerCheckpoint.findUniqueOrThrow({ where: { address: curve } });
    expect(ok).toMatchObject({ lastSignature: buy, errorCount: 0, lastError: null });
  });

  it("transaksi belum tersedia di RPC → berhenti tanpa memajukan checkpoint", async () => {
    const mint = await seedToken();
    const { chain, curve, buy } = setup(mint);
    chain.txs.set(buy, null);
    await indexerFor(chain).runCycle();
    const cp = await db.indexerCheckpoint.findUniqueOrThrow({ where: { address: curve } });
    expect(cp.lastSignature).not.toBe(buy);
    expect(cp.processed).toBe(1); // hanya transaksi create
  });

  it("transaksi versi tak didukung dilewati dan dicatat di audit_events", async () => {
    const mint = await seedToken();
    const { chain, curve } = setup(mint);
    const sig = chain.push([curve], "unsupported", uniqueSig("v1"));
    await indexerFor(chain).runCycle();
    const cp = await db.indexerCheckpoint.findUniqueOrThrow({ where: { address: curve } });
    expect(cp.lastSignature).toBe(sig);
    expect(
      await db.auditEvent.count({ where: { action: "indexer.tx_unsupported", txSignature: sig } }),
    ).toBe(1);
  });

  it("event dari pool lain diabaikan; beberapa trade satu transaksi → creator fee dijumlahkan", async () => {
    const mint = await seedToken();
    const { chain, curve } = setup(mint);
    const foreign = chain.push(
      [curve],
      parsedTx(uniqueSig("foreign"), { launchlab: [curveEvent("other-pool")] }),
    );
    const double = chain.push(
      [curve],
      parsedTx(uniqueSig("double"), {
        launchlab: [curveEvent(curve), curveEvent(curve, { creatorFee: 5_000n })],
      }),
    );
    await indexerFor(chain).runCycle();
    expect((await ledgerFor(foreign)).receipts).toHaveLength(0);
    expect((await ledgerFor(double)).fees[0]!.amount.toFixed(0)).toBe("25000");
  });

  it("snapshot pasar: harga curve, progres, likuiditas, holder tanpa vault pool", async () => {
    const mint = await seedToken();
    const { chain } = setup(mint);
    await indexerFor(chain).runCycle();
    const m = await db.tokenMarket.findUniqueOrThrow({ where: { tokenMint: mint } });
    expect(m).toMatchObject({ route: "launchlab", curveStatus: 0, holders: 2 });
    // 0,03393 SOL / 1.072.875.609,04947 token (6 desimal).
    expect(m.priceQuote!.toFixed(18)).toBe("0.000000000031625288");
    expect(m.curveRaisedRaw.toFixed(0)).toBe("3930000");
    expect(m.liquidityQuoteRaw.toFixed(0)).toBe("3930000");
  });

  it("graduation: migrating → verified otomatis, graduatedAt terisi, swap CPMM tercatat", async () => {
    const mint = await seedToken();
    const { chain, curve } = setup(mint);
    chain.launchPools.set(curve, launchPool(curve, mint, SOL.mint, MASTER, { status: 1 }));
    await indexerFor(chain).runCycle();
    expect(
      await db.tokenGraduation.findUniqueOrThrow({ where: { tokenMint: mint } }),
    ).toMatchObject({ state: "migrating", reserveMonitoringActive: false });
    expect((await db.token.findFirstOrThrow({ where: { mint } })).graduatedAt).toBeNull();

    // Migrasi Raydium: pool CPMM dibuat oleh transaksi LaunchLab yang menyentuh curve.
    const cpAddr = await chain.cpmmPoolAddress(mint);
    chain.launchPools.set(curve, launchPool(curve, mint, SOL.mint, MASTER, { status: 2 }));
    chain.cpmmPools.set(cpAddr, cpmmPool(cpAddr, mint, SOL.mint, MASTER));
    const migrate = chain.push(
      [curve, cpAddr],
      parsedTx(uniqueSig("migrate"), { accountKeys: [PROGRAMS.launchlab, curve, cpAddr] }),
    );
    chain.supplies.set(`lp-${mint}`, 71_920_094_549n);
    chain.accounts.set(`lp-${mint}`, [
      { address: "lock", owner: raydiumAuthoritiesFor("devnet").lockCpmm, amount: 71_920_094_549n },
    ]);
    const swap = chain.push(
      [cpAddr],
      parsedTx(uniqueSig("swap"), { cpmm: [swapEvent(cpAddr, SOL.mint, mint)] }),
    );
    await indexerFor(chain).runCycle();

    const g = await db.tokenGraduation.findUniqueOrThrow({ where: { tokenMint: mint } });
    expect(g).toMatchObject({
      state: "verified",
      cpmmPool: cpAddr,
      migrateSignature: migrate,
      addLiquiditySupported: true,
      reserveMonitoringActive: true,
    });
    expect(g.lpFreeRaw!.toFixed(0)).toBe("0");
    const token = await db.token.findFirstOrThrow({ where: { mint } });
    expect(token.graduatedAt).toEqual(new Date(1_793_000_000 * 1000));
    expect(await db.tokenMarket.findUniqueOrThrow({ where: { tokenMint: mint } })).toMatchObject({
      route: "cpmm",
      cpmmPool: cpAddr,
    });
    const l = await ledgerFor(swap);
    expect(l.receipts[0]).toMatchObject({ route: "cpmm", side: "buy" });
    expect(l.fees.map((f) => f.amount.toFixed(0))).toEqual(["12500", "10000", "2500"]);
    expect(
      await db.auditEvent.count({
        where: { action: "indexer.graduation", details: { path: ["mint"], equals: mint } },
      }),
    ).toBe(2);
  });

  it("pool hasil migrasi dengan config asing → failed, token tidak pindah ke Graduated", async () => {
    const mint = await seedToken();
    const { chain, curve } = setup(mint);
    const cpAddr = await chain.cpmmPoolAddress(mint);
    chain.launchPools.set(curve, launchPool(curve, mint, SOL.mint, MASTER, { status: 2 }));
    chain.cpmmPools.set(cpAddr, cpmmPool(cpAddr, mint, SOL.mint, MASTER, { configId: "Other" }));
    chain.push(
      [curve, cpAddr],
      parsedTx(uniqueSig("migrate"), { accountKeys: [PROGRAMS.launchlab, curve] }),
    );
    chain.supplies.set(`lp-${mint}`, 1n);
    chain.accounts.set(`lp-${mint}`, [
      { address: "l", owner: raydiumAuthoritiesFor("devnet").lockCpmm, amount: 1n },
    ]);
    await indexerFor(chain).runCycle();
    const g = await db.tokenGraduation.findUniqueOrThrow({ where: { tokenMint: mint } });
    expect(g.state).toBe("failed");
    expect(g.reserveMonitoringActive).toBe(false);
    expect((await db.token.findFirstOrThrow({ where: { mint } })).graduatedAt).toBeNull();
  });
});
