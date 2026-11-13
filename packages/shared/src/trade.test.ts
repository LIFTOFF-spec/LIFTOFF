import { describe, expect, it } from "vitest";
import { FEE_CONFIG } from "./fee-config";
import {
  assertGraduatedRouteAllowed,
  bpsToRaydiumRate,
  referralShareRate,
  tradeQuoteRequestSchema,
} from "./trade";

describe("referral LIFTOFF", () => {
  it("FEE_CONFIG.referralFeeBps dikonversi ke rate on-chain (per 1e6)", () => {
    expect(bpsToRaydiumRate(100)).toBe(10_000);
    expect(referralShareRate(10_000)).toBe(bpsToRaydiumRate(FEE_CONFIG.referralFeeBps));
  });

  it("dibatasi maxShareFeeRate config; config RAY (0) → tanpa referral", () => {
    expect(referralShareRate(5_000, 100)).toBe(5_000);
    expect(referralShareRate(0, 100)).toBe(0);
  });
});

describe("rute sesudah graduate", () => {
  it("jupiter hanya mainnet, cpmm di mana saja", () => {
    expect(() => assertGraduatedRouteAllowed("jupiter", "devnet")).toThrow(/tidak tersedia/);
    expect(() => assertGraduatedRouteAllowed("jupiter", "mainnet-beta")).not.toThrow();
    expect(() => assertGraduatedRouteAllowed("cpmm", "devnet")).not.toThrow();
  });
});

describe("tradeQuoteRequestSchema", () => {
  const base = {
    mint: "So11111111111111111111111111111111111111112",
    side: "buy",
    slippageBps: 100,
  };
  it("jumlah harus integer satuan terkecil dalam rentang u64", () => {
    expect(tradeQuoteRequestSchema.safeParse({ ...base, amountIn: "1000" }).success).toBe(true);
    for (const amountIn of ["0", "01", "1.5", "-1", "18446744073709551616"]) {
      expect(tradeQuoteRequestSchema.safeParse({ ...base, amountIn }).success).toBe(false);
    }
  });
});
