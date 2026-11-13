import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OnChainTrade } from "@liftoff/solana/trade";
import type { BuiltTrade, TradeQuote } from "@liftoff/shared";
import { tokenAccountOf, type TradeService } from "./lib/trade";
import { loadConfig } from "./config";
import { makeApp, newWallet, nextIp, resetDb } from "./test-helpers";

type Ctx = Awaited<ReturnType<typeof makeApp>>;
let ctx: Ctx;

const WSOL = "So11111111111111111111111111111111111111112";
const LAUNCH_POOL = "AyqHgZtBYTzecMvnRCFtGP8gBLg96FzCofXBCdQPZqdP";
const CPMM_POOL = "5BNHV8wrPAEAbf22kLDbYFaviTCr7P1q2KkonKK3E77j";
const MASTER = "4xU25ckRqi5aeRZsAvZotvBCRcyQH3rvdPN3x5pgmCFj";

/** Transaksi on-chain yang dikembalikan service palsu, per signature. */
const chain = new Map<string, OnChainTrade>();
const calls: { quote: unknown[]; build: unknown[] } = { quote: [], build: [] };

class TradeErr extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TradeError";
  }
}

const fakeQuote = { route: "launchlab", fees: [] } as unknown as TradeQuote;

const fakeTrade: TradeService = {
  async quote(t, p) {
    calls.quote.push({ t, p });
    if (p.amountIn === 7n) throw new TradeErr("curve_migrating", "The bonding curve is complete.");
    return fakeQuote;
  },
  async build(t, p) {
    calls.build.push({ t, p });
    return {
      quote: fakeQuote,
      transaction: "AA==",
      simulation: { ok: true },
    } as unknown as BuiltTrade;
  },
  async read(signature) {
    return chain.get(signature) ?? null;
  },
  async pools() {
    return { launchPool: LAUNCH_POOL, cpmmPool: CPMM_POOL };
  },
};

/** App dengan referral DIAKTIFKAN eksplisit (mekanisme tetap diuji walau default-nya mati). */
let referralOff: Ctx;
beforeAll(async () => {
  ctx = await makeApp({ trade: fakeTrade, config: { tradeReferralWallet: MASTER } });
  referralOff = await makeApp({ trade: fakeTrade });
}, 120_000);
afterAll(async () => {
  await ctx.app.close();
  await referralOff.app.close();
});
beforeEach(() => resetDb(ctx.db));

async function seedLiveToken(mint: string) {
  const user = await ctx.db.user.create({ data: { wallet: newWallet().address } });
  return ctx.db.token.create({
    data: {
      name: "Trade coin",
      ticker: "TRD",
      tickerNormalized: "trd",
      mint,
      quoteMint: WSOL,
      quoteConfigId: "7ZR4zD7PYfY2XxoG1Gxcy2EgEeGYrpxrwzPuwdUBssEt",
      creatorUserId: user.id,
      launchStatus: "live",
    },
  });
}

/** Signature acak base58 (88 karakter). Ledger append-only → harus unik per test. */
function fakeSignature() {
  return (newWallet().address + newWallet().address).slice(0, 88);
}

function curveTrade(
  signature: string,
  mint: string,
  share: bigint,
  shareAta: string,
): OnChainTrade {
  return {
    signature,
    slot: 1,
    wallet: newWallet().address,
    failed: false,
    launchlab: {
      pool: LAUNCH_POOL,
      amountIn: 100_000_000n,
      amountOut: 5_000_000n,
      protocolFee: 250_000n,
      platformFee: 1_000_000n,
      creatorFee: 0n,
      shareFee: share,
      direction: 0,
      poolStatus: 0,
      realQuoteAfter: 0n,
      virtualBase: 1_073_025_609_049_470n,
      virtualQuote: 30_000_000_000n,
      realBaseAfter: 5_000_000n,
    },
    cpmm: null,
    tokenDeltas: [{ account: shareAta, owner: MASTER, mint: WSOL, delta: share }],
  };
}

const confirm = (mint: string, signature: string) =>
  ctx.app.inject({
    method: "POST",
    url: "/api/trade/confirm",
    payload: { mint, signature },
    remoteAddress: nextIp(),
  });

describe("POST /api/trade/quote & build", () => {
  it("menolak token yang tidak ada / belum live", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/trade/quote",
      payload: { mint: newWallet().address, side: "buy", amountIn: "1000", slippageBps: 100 },
      remoteAddress: nextIp(),
    });
    expect(res.statusCode).toBe(404);
  });

  it("validasi input: jumlah harus bilangan bulat positif, slippage dibatasi", async () => {
    const mint = newWallet().address;
    await seedLiveToken(mint);
    for (const payload of [
      { mint, side: "buy", amountIn: "0", slippageBps: 100 },
      { mint, side: "buy", amountIn: "1.5", slippageBps: 100 },
      { mint, side: "buy", amountIn: "1000", slippageBps: 9_000 },
      { mint, side: "hold", amountIn: "1000", slippageBps: 100 },
    ]) {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/trade/quote",
        payload,
        remoteAddress: nextIp(),
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("meneruskan pair token & memetakan TradeError ke 422 dengan kode", async () => {
    const mint = newWallet().address;
    await seedLiveToken(mint);
    const ok = await ctx.app.inject({
      method: "POST",
      url: "/api/trade/quote",
      payload: { mint, side: "buy", amountIn: "1000", slippageBps: 100 },
      remoteAddress: nextIp(),
    });
    expect(ok.statusCode).toBe(200);
    const last = calls.quote.at(-1) as { t: { pair: { mint: string } }; p: { amountIn: bigint } };
    expect(last.t.pair.mint).toBe(WSOL);
    expect(last.p.amountIn).toBe(1000n);

    const bad = await ctx.app.inject({
      method: "POST",
      url: "/api/trade/quote",
      payload: { mint, side: "buy", amountIn: "7", slippageBps: 100 },
      remoteAddress: nextIp(),
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe("curve_migrating");
  });

  it("build butuh wallet valid dan meneruskannya sebagai fee payer", async () => {
    const mint = newWallet().address;
    await seedLiveToken(mint);
    const wallet = newWallet().address;
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/trade/build",
      payload: { mint, side: "sell", amountIn: "5", slippageBps: 50, wallet },
      remoteAddress: nextIp(),
    });
    expect(res.statusCode).toBe(200);
    expect((calls.build.at(-1) as { p: { wallet: string } }).p.wallet).toBe(wallet);
    const missing = await ctx.app.inject({
      method: "POST",
      url: "/api/trade/build",
      payload: { mint, side: "sell", amountIn: "5", slippageBps: 50 },
      remoteAddress: nextIp(),
    });
    expect(missing.statusCode).toBe(400);
  });
});

describe("referral dimatikan (FEE_CONFIG.referralFeeBps = 0, keputusan pemilik)", () => {
  it("config default tidak punya wallet referral, walau TRADE_REFERRAL_WALLET diisi", () => {
    expect(referralOff.config.tradeReferralWallet).toBeNull();
    const cfg = loadConfig({
      NODE_ENV: "test",
      SOLANA_CLUSTER: "devnet",
      TRADE_REFERRAL_WALLET: MASTER,
    } as NodeJS.ProcessEnv);
    expect(cfg.tradeReferralWallet).toBeNull();
  });

  it("confirm tidak membuat entri fee_ledger source=referral", async () => {
    const mint = newWallet().address;
    await seedLiveToken(mint);
    const sig = fakeSignature();
    chain.set(sig, curveTrade(sig, mint, 1_000_000n, tokenAccountOf(MASTER, WSOL)));
    const res = await referralOff.app.inject({
      method: "POST",
      url: "/api/trade/confirm",
      payload: { mint, signature: sig },
      remoteAddress: nextIp(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().referralLedgerEntry).toBeNull();
    expect(await ctx.db.feeLedger.count({ where: { sourceSignature: sig } })).toBe(0);
  });
});

describe("POST /api/trade/confirm (referral diaktifkan eksplisit)", () => {
  it("fee aktual dari event on-chain + referral dilaporkan pending (API tidak menulis fee_ledger, F4)", async () => {
    const mint = newWallet().address;
    await seedLiveToken(mint);
    const sig = fakeSignature();
    chain.set(sig, curveTrade(sig, mint, 1_000_000n, tokenAccountOf(MASTER, WSOL)));

    const first = await confirm(mint, sig);
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body.route).toBe("launchlab");
    expect(body.side).toBe("buy");
    const fee = (kind: string) => body.fees.find((f: { kind: string }) => f.kind === kind);
    expect(fee("platform")).toMatchObject({ amount: "1000000", rate: 10_000 });
    expect(fee("raydium_protocol")).toMatchObject({ amount: "250000", rate: 2_500 });
    expect(fee("referral")).toMatchObject({ amount: "1000000", recipient: MASTER });
    expect(body.referralLedgerEntry).toEqual({
      amount: "1000000",
      assetMint: WSOL,
      recorded: "pending",
    });

    const again = await confirm(mint, sig);
    expect(again.json().referralLedgerEntry.recorded).toBe("pending");
    expect(await ctx.db.feeLedger.count({ where: { sourceSignature: sig } })).toBe(0);
    expect(await ctx.db.tradeReceipt.count({ where: { signature: sig } })).toBe(1);
  });

  it("share fee yang tidak masuk ke ATA referral LIFTOFF tidak dicatat", async () => {
    const mint = newWallet().address;
    await seedLiveToken(mint);
    const sig = fakeSignature();
    chain.set(sig, curveTrade(sig, mint, 1_000_000n, tokenAccountOf(newWallet().address, WSOL)));
    const res = await confirm(mint, sig);
    expect(res.statusCode).toBe(200);
    expect(res.json().referralLedgerEntry).toBeNull();
    expect(await ctx.db.feeLedger.count({ where: { sourceSignature: sig } })).toBe(0);
  });

  it("menolak transaksi di pool lain, transaksi gagal, dan yang belum terkonfirmasi", async () => {
    const mint = newWallet().address;
    await seedLiveToken(mint);
    const other = fakeSignature();
    const t = curveTrade(other, mint, 0n, "x");
    chain.set(other, { ...t, launchlab: { ...t.launchlab!, pool: newWallet().address } });
    expect((await confirm(mint, other)).json().error.code).toBe("not_liftoff_trade");

    const failed = fakeSignature();
    chain.set(failed, { ...curveTrade(failed, mint, 0n, "x"), failed: true });
    expect((await confirm(mint, failed)).json().error.code).toBe("trade_failed");

    const pending = await confirm(mint, fakeSignature());
    expect(pending.statusCode).toBe(409);
    expect(pending.json().error.code).toBe("trade_pending");
  });

  it("swap CPMM sesudah graduate: trade & creator fee dari SwapEvent, tanpa entri referral", async () => {
    const mint = newWallet().address;
    await seedLiveToken(mint);
    const sig = fakeSignature();
    chain.set(sig, {
      signature: sig,
      slot: 2,
      wallet: newWallet().address,
      failed: false,
      launchlab: null,
      cpmm: {
        pool: CPMM_POOL,
        inputVaultBefore: 1_000_000_000n,
        outputVaultBefore: 400_000_000_000_000n,
        inputAmount: 20_000_000n,
        outputAmount: 7_919_426_843_313n,
        inputMint: WSOL,
        outputMint: mint,
        tradeFee: 50_000n,
        creatorFee: 50_000n,
        creatorFeeOnInput: true,
      },
      tokenDeltas: [],
    });
    const res = await confirm(mint, sig);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      route: "cpmm",
      side: "buy",
      referralLedgerEntry: null,
      fees: [
        { kind: "raydium_lp", amount: "50000", rate: 2_500, mint: WSOL },
        { kind: "creator", amount: "50000", rate: 2_500, mint: WSOL },
      ],
    });
  });
});

describe("creator fee → master wallet → alokasi 80/20 (Spec §9–10, §13)", () => {
  it("trade curve: API mencatat receipt saja; indexer mencatat received + 80/20 + reserve SEKALI", async () => {
    const mint = newWallet().address;
    await seedLiveToken(mint);
    const sig = fakeSignature();
    const t = curveTrade(sig, mint, 0n, "x");
    // 501 lamport: 20% = 100,2 → reserve 100 (floor), buyback 401 (termasuk sisa 0,2).
    chain.set(sig, { ...t, launchlab: { ...t.launchlab!, creatorFee: 501n } });

    const first = await referralOff.app.inject({
      method: "POST",
      url: "/api/trade/confirm",
      payload: { mint, signature: sig },
      remoteAddress: nextIp(),
    });
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body.fees.find((f: { kind: string }) => f.kind === "creator")).toMatchObject({
      amount: "501",
      recipient: MASTER,
    });
    expect(body.creatorFeeEntry).toEqual({
      amount: "501",
      assetMint: WSOL,
      buybackBurn: "401",
      convictionReserve: "100",
      recorded: "pending",
    });
    // F4: role DB API tidak boleh menulis ledger ekonomi → belum ada entri dari API.
    expect(await ctx.db.feeLedger.count({ where: { sourceSignature: sig } })).toBe(0);
    expect(await ctx.db.reserveLedger.count({ where: { txSignature: sig } })).toBe(0);

    // Indexer (role worker) mencatat dari transaksi on-chain yang sama, idempoten per signature.
    const { recordTradeAndCreatorFee } = await import("@liftoff/db");
    const receipt = { ...body };
    delete receipt.referralLedgerEntry;
    delete receipt.creatorFeeEntry;
    const recorded = await recordTradeAndCreatorFee(ctx.db, receipt, WSOL, {
      recordedBy: "indexer",
    });
    expect(recorded).toMatchObject({
      buybackBurn: "401",
      convictionReserve: "100",
      recorded: "new",
    });
    const again = await recordTradeAndCreatorFee(ctx.db, receipt, WSOL, { recordedBy: "indexer" });
    expect(again?.recorded).toBe("existing");

    const rows = await ctx.db.feeLedger.findMany({ where: { sourceSignature: sig } });
    const byType = Object.fromEntries(rows.map((r) => [r.entryType, r.amount.toFixed(0)]));
    expect(rows).toHaveLength(3);
    expect(byType).toEqual({ received: "501", allocated_buyback: "401", allocated_reserve: "100" });
    expect(rows.every((r) => r.source === "creator_fee" && r.attribution === "verified")).toBe(
      true,
    );
    expect(rows.some((r) => r.entryType === "allocated_treasury")).toBe(false);
    const reserve = await ctx.db.reserveLedger.findMany({ where: { txSignature: sig } });
    expect(reserve.map((r) => [r.entryType, r.amount.toFixed(0)])).toEqual([
      ["contribution", "100"],
    ]);
    expect(await ctx.db.tradeReceipt.count({ where: { signature: sig } })).toBe(1);

    // Ledger token: total alokasi = fee diterima, tanpa treasury.
    const ledger = await ctx.app.inject({ method: "GET", url: `/api/tokens/${mint}/ledger` });
    const totals = ledger.json().data.totals;
    expect(totals.feesReceived.value).toBe("0.000000501");
    expect(totals.allocatedBuyback.value).toBe("0.000000401");
    expect(totals.allocatedReserve.value).toBe("0.0000001");
    expect(totals).not.toHaveProperty("allocatedTreasury");

    // Statistik live: volume dari receipt, reserve terkumpul dari ledger.
    const stats = (await ctx.app.inject({ method: "GET", url: "/api/stats" })).json().data;
    expect(stats.tokensLaunched.value).toBe("1");
    expect(Number(stats.tradingVolumeUsd.value)).toBeGreaterThan(0);
    expect(stats.reserveAccumulatedUsd.status).toBe("estimated");
  });

  it("swap CPMM: creator fee pool (0,25%) juga 80/20", async () => {
    const mint = newWallet().address;
    await seedLiveToken(mint);
    const sig = fakeSignature();
    chain.set(sig, {
      signature: sig,
      slot: 3,
      wallet: newWallet().address,
      failed: false,
      launchlab: null,
      cpmm: {
        pool: CPMM_POOL,
        inputVaultBefore: 1_000_000_000n,
        outputVaultBefore: 400_000_000_000_000n,
        inputAmount: 20_000_000n,
        outputAmount: 7_919_426_843_313n,
        inputMint: WSOL,
        outputMint: mint,
        tradeFee: 50_000n,
        creatorFee: 50_000n,
        creatorFeeOnInput: true,
      },
      tokenDeltas: [],
    });
    const res = await confirm(mint, sig);
    expect(res.json().creatorFeeEntry).toMatchObject({
      amount: "50000",
      buybackBurn: "40000",
      convictionReserve: "10000",
    });
  });
});
