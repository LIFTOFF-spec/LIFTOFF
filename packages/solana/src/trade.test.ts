import { PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyTradeFailure,
  cpmmCreatorFeeOnInput,
  decodeCpmmSwapEvent,
  decodeLaunchlabTradeEvent,
  getTransactionAnyVersion,
  migratedCpmmPoolAddress,
  parseTradeTransaction,
  UnsupportedTransactionError,
  versionedResponseFromRaw,
  type RawTransactionResponse,
} from "./trade";

describe("transaksi versi 1", () => {
  const PAYER = "HxM1EeyZ9z71m8mu5x9bsUdtTP1f9qtT7mo9D5tB3xwM";
  const ACCOUNT = "ChWZ8yNvMh31yHtkZh3fSjWZaQiv62bHr1WPnUPLvuLF";
  const PROGRAM = "11111111111111111111111111111111";
  const balance = (amount: string) => ({
    accountIndex: 1,
    mint: ACCOUNT,
    owner: PAYER,
    uiTokenAmount: { amount, decimals: 6, uiAmount: null },
  });
  const raw = (): RawTransactionResponse => ({
    slot: 7,
    blockTime: 100,
    meta: {
      err: null,
      fee: 5000,
      preBalances: [1, 2, 3],
      postBalances: [1, 2, 3],
      innerInstructions: [],
      logMessages: [],
      preTokenBalances: [balance("10")],
      postTokenBalances: [balance("25")],
      loadedAddresses: { writable: [], readonly: [] },
    },
    transaction: {
      signatures: ["sig"],
      message: {
        header: {
          numRequiredSignatures: 1,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 1,
        },
        accountKeys: [PAYER, ACCOUNT, PROGRAM],
        recentBlockhash: PAYER,
        instructions: [{ programIdIndex: 2, accounts: [0, 1], data: "3Bxs" }],
      },
    },
  });
  const rejecting = {
    rpcEndpoint: "https://rpc.test/?api-key=rahasia",
    getTransaction: () =>
      Promise.reject(new Error("Transaction version (1) is not supported by the client")),
  } as unknown as Connection;

  afterEach(() => vi.unstubAllGlobals());

  it("bisa diurai seperti transaksi biasa: wallet, akun, dan Δ saldo token", () => {
    const parsed = parseTradeTransaction(versionedResponseFromRaw(raw(), "sig"), "sig", {
      launchlab: PROGRAM,
      cpmm: PROGRAM,
    });
    expect(parsed.wallet).toBe(PAYER);
    expect(parsed.slot).toBe(7);
    expect(parsed.accountKeys).toEqual([PAYER, ACCOUNT, PROGRAM]);
    expect(parsed.tokenDeltas).toEqual([
      { account: ACCOUNT, owner: PAYER, mint: ACCOUNT, delta: 15n },
    ]);
  });

  it("lookup table tidak ditebak: ditolak sebagai tidak didukung", () => {
    const r = raw();
    r.meta!.loadedAddresses = { writable: [ACCOUNT], readonly: [] };
    expect(() => versionedResponseFromRaw(r, "sig")).toThrow(UnsupportedTransactionError);
  });

  it("ditolak web3.js → dibaca lewat JSON-RPC langsung dengan versi 1", async () => {
    const fetchMock = vi.fn(async () => Response.json({ result: raw() }));
    vi.stubGlobal("fetch", fetchMock);
    const tx = await getTransactionAnyVersion(rejecting, "sig");
    expect(tx?.slot).toBe(7);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(String(init.body)).toContain('"maxSupportedTransactionVersion":1');
  });

  it("versi lebih baru tetap UnsupportedTransactionError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          error: { code: -32015, message: "Transaction version (2) is not supported" },
        }),
      ),
    );
    await expect(getTransactionAnyVersion(rejecting, "sig")).rejects.toThrow(
      UnsupportedTransactionError,
    );
  });

  it("error RPC tidak membocorkan URL (API key)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 })),
    );
    const err = (await getTransactionAnyVersion(rejecting, "sig").catch((e) => e)) as Error;
    expect(err.message).toContain("HTTP 500");
    expect(err.message).not.toContain("rahasia");
  });

  it("error lain dari web3.js diteruskan apa adanya", async () => {
    const conn = {
      getTransaction: () => Promise.reject(new Error("rate limited")),
    } as unknown as Connection;
    await expect(getTransactionAnyVersion(conn, "sig")).rejects.toThrow("rate limited");
  });
});

describe("decodeLaunchlabTradeEvent", () => {
  it("mengurai TradeEvent nyata dari trade PoC Tahap 1 (buy 0,1 SOL, fee 1%)", () => {
    // Inner instruction emit_cpi dari tx 2tdBJrU9… (devnet).
    const hex =
      "e445a52e51cb9a1dbddb7fd34ee661ee94484e7faf87931aebd9479a562807e70f82625a551994324c7bda104aa3973e0078c5fb51d10200ea220f3ee9cf03005637132a0000000000000000000000000000000000000000e8ace57bc477000030cee2050000000000e1f50500000000e8ace57bc477000090d003000000000040420f000000000000000000000000000000000000000000000001";
    const e = decodeLaunchlabTradeEvent(Buffer.from(hex, "hex"))!;
    expect(e.pool).toBe("AyqHgZtBYTzecMvnRCFtGP8gBLg96FzCofXBCdQPZqdP");
    expect(e.amountIn).toBe(100_000_000n);
    expect(e.platformFee).toBe(1_000_000n);
    expect(e.protocolFee).toBe(250_000n);
    expect(e.shareFee).toBe(0n);
    expect(e.direction).toBe(0);
  });

  it("mengabaikan data yang bukan TradeEvent", () => {
    expect(decodeLaunchlabTradeEvent(Buffer.alloc(155))).toBeNull();
    expect(decodeLaunchlabTradeEvent(Buffer.from("e445a52e51cb9a1d", "hex"))).toBeNull();
  });
});

describe("decodeCpmmSwapEvent", () => {
  it("mengurai layout SwapEvent cp-swap", () => {
    const pool = new PublicKey("5BNHV8wrPAEAbf22kLDbYFaviTCr7P1q2KkonKK3E77j");
    const inMint = new PublicKey("So11111111111111111111111111111111111111112");
    const outMint = new PublicKey("GLqjtbRYhbSah5uJ37xWLM9mbEhrEW1wAZXRPs89pryE");
    const u64 = (v: bigint) => {
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(v);
      return b;
    };
    const data = Buffer.concat([
      Buffer.from("40c6cde8260871e2", "hex"),
      pool.toBuffer(),
      u64(1n), // input vault before
      u64(2n), // output vault before
      u64(20_000_000n),
      u64(7_919_426_843_313n),
      u64(0n),
      u64(0n),
      Buffer.from([1]), // base_input
      inMint.toBuffer(),
      outMint.toBuffer(),
      u64(50_000n),
      u64(50_000n),
      Buffer.from([1]),
    ]);
    expect(decodeCpmmSwapEvent(data)).toEqual({
      pool: pool.toBase58(),
      inputVaultBefore: 1n,
      outputVaultBefore: 2n,
      inputAmount: 20_000_000n,
      outputAmount: 7_919_426_843_313n,
      inputMint: inMint.toBase58(),
      outputMint: outMint.toBase58(),
      tradeFee: 50_000n,
      creatorFee: 50_000n,
      creatorFeeOnInput: true,
    });
    expect(decodeCpmmSwapEvent(Buffer.alloc(200))).toBeNull();
  });
});

describe("CPMM helpers", () => {
  it("PDA pool hasil migrasi = pool LFTG di devnet (mint diurutkan)", () => {
    const args = [
      "DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb",
      "5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy",
    ] as const;
    const a = "GLqjtbRYhbSah5uJ37xWLM9mbEhrEW1wAZXRPs89pryE";
    const b = "So11111111111111111111111111111111111111112";
    expect(migratedCpmmPoolAddress(...args, a, b)).toBe(
      "5BNHV8wrPAEAbf22kLDbYFaviTCr7P1q2KkonKK3E77j",
    );
    expect(migratedCpmmPoolAddress(...args, b, a)).toBe(migratedCpmmPoolAddress(...args, a, b));
  });

  it("creator fee di sisi input mengikuti feeOn pool (sama dengan program cp-swap)", () => {
    expect(cpmmCreatorFeeOnInput(0, true)).toBe(true);
    expect(cpmmCreatorFeeOnInput(0, false)).toBe(true);
    expect(cpmmCreatorFeeOnInput(1, true)).toBe(true);
    expect(cpmmCreatorFeeOnInput(1, false)).toBe(false);
    expect(cpmmCreatorFeeOnInput(2, true)).toBe(false);
    expect(cpmmCreatorFeeOnInput(2, false)).toBe(true);
  });
});

describe("classifyTradeFailure", () => {
  it("memetakan log simulasi ke kode yang jelas", () => {
    const code = (logs: string[], err: unknown = null) => classifyTradeFailure(logs, err).code;
    expect(
      code(["Program log: AnchorError … Error Code: ExceededSlippage. Error Number: 6004."]),
    ).toBe("slippage_exceeded");
    expect(code(["Program log: AnchorError … Error Code: PoolMigrated. Error Number: 6006."])).toBe(
      "curve_migrated",
    );
    expect(code(["Transfer: insufficient lamports 100, need 200"])).toBe("insufficient_balance");
    expect(code([], "AccountNotFound: no record of a prior credit")).toBe("insufficient_balance");
    expect(code(["Program log: Error: insufficient funds"])).toBe("insufficient_token_balance");
    const other = classifyTradeFailure(["Program log: something failed badly"], { x: 1 });
    expect(other.code).toBe("simulation_failed");
    expect(other.message).toContain("something failed badly");
  });
});
