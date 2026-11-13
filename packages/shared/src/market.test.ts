import { describe, expect, it } from "vitest";
import {
  curveProgressPct,
  decimalToScaled,
  freshness,
  pctChange,
  priceFromReserves,
  rawToDecimal,
  valueAtPrice,
} from "./market";

describe("aritmetika pasar (tanpa float)", () => {
  it("harga curve $LFTGRD dari cadangan on-chain", () => {
    // virtualB + realB = 135.295.121 lamport; virtualA − realA = 279.925.609.049.470 unit.
    expect(priceFromReserves(135_295_121n, 279_925_609_049_470n, 9, 6)).toBe(
      "0.000000000483325271522727664469",
    );
    expect(priceFromReserves(1n, 0n, 9, 6)).toBeNull();
  });

  it("market cap = harga × supply, dalam satuan terkecil quote", () => {
    expect(valueAtPrice("0.000000000483325", 1_000_000_000_000_000n, 6, 9)).toBe(483_325_000n);
  });

  it("progres curve dibatasi 100%", () => {
    expect(curveProgressPct(60_000_000n, 100_000_000n)).toBe("60");
    expect(curveProgressPct(123n, 100n)).toBe("100");
    expect(curveProgressPct(1n, 0n)).toBe("0");
  });

  it("perubahan harga 24 jam", () => {
    expect(pctChange("0.0000000004", "0.000000000483325")).toBe("20.8");
    expect(pctChange("2", "1")).toBe("-50");
    expect(pctChange(null, "1")).toBeNull();
  });

  it("konversi desimal ↔ bigint berskala", () => {
    expect(rawToDecimal(1_102_540n, 9)).toBe("0.00110254");
    expect(rawToDecimal(-5n, 1)).toBe("-0.5");
    expect(decimalToScaled("1.5", 2)).toBe(150n);
    expect(() => decimalToScaled("1e-9")).toThrow();
  });

  it("snapshot tertinggal → delayed", () => {
    const now = Date.parse("2026-10-29T00:10:00Z");
    expect(freshness(new Date("2026-10-29T00:09:00Z"), now)).toBe("verified");
    expect(freshness(new Date("2026-10-29T00:00:00Z"), now)).toBe("delayed");
  });
});
