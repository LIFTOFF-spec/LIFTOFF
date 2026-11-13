import { describe, expect, it } from "vitest";
import { formatRate, formatUnits, parseUnits, toPlainUnits } from "./units";

describe("parseUnits", () => {
  it("mengonversi desimal ke satuan terkecil tanpa float", () => {
    expect(parseUnits("0.1", 9)).toBe(100_000_000n);
    expect(parseUnits("1,5", 6)).toBe(1_500_000n);
    expect(parseUnits(".000000001", 9)).toBe(1n);
    expect(parseUnits("123456789.123456", 6)).toBe(123_456_789_123_456n);
  });

  it("menolak input tidak valid atau desimal berlebih", () => {
    expect(parseUnits("", 9)).toBeNull();
    expect(parseUnits(".", 9)).toBeNull();
    expect(parseUnits("1e5", 9)).toBeNull();
    expect(parseUnits("0.0000001", 6)).toBeNull();
  });
});

describe("formatUnits", () => {
  it("memformat dengan pemisah ribuan dan memotong desimal", () => {
    expect(formatUnits("1234567890", 9)).toBe("1.23456789");
    expect(formatUnits(8_872_228_448_296n, 6, 2)).toBe("8,872,228.44");
    expect(formatUnits("0", 6)).toBe("0");
    expect(toPlainUnits(8_872_228_448_296n, 6)).toBe("8872228.448296");
  });
});

describe("formatRate", () => {
  it("rate per 1e6 → persen", () => {
    expect(formatRate(10_000)).toBe("1%");
    expect(formatRate(2_500)).toBe("0.25%");
  });
});
