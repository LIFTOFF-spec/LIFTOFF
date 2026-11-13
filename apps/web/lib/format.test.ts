import { describe, expect, it } from "vitest";
import { formatChartPrice, formatPrice, formatUsd } from "./format";

describe("formatChartPrice", () => {
  it.each([
    ["0.000000027959", "0.0₇2796"],
    [0.00123, "0.00123"],
    [27.96, "27.96"],
    [0, "0"],
    ["bukan angka", "—"],
  ])("%s → %s", (value, expected) => {
    expect(formatChartPrice(value)).toBe(expected);
  });
});

describe("formatPrice", () => {
  it.each([
    ["0.000002595", "$0.0₅2595"],
    ["1.856e-7", "$0.0₆1856"],
    [0.00001, "$0.0₄1"],
    [1.5e-12, "$0.0₁₁15"],
    [0.0001234, "$0.0₃1234"],
    [0.001234, "$0.001234"],
    [0.1234567, "$0.1235"],
    [0, "$0"],
    [1.5, "$1.5"],
    [2640, "$2.64K"],
    ["bukan angka", "—"],
  ])("%s → %s", (value, expected) => {
    expect(formatPrice(value)).toBe(expected);
  });

  it("pembulatan ke atas tetap benar", () => {
    // Dibulatkan menjadi 0.00001, jadi jumlah nol ikut berkurang.
    expect(formatPrice(0.00000999999)).toBe("$0.0₄1");
  });

  it("formatUsd memakai format yang sama untuk nilai sangat kecil", () => {
    expect(formatUsd("0.000002595")).toBe("$0.0₅2595");
    expect(formatUsd(450.87)).toBe("$450.87");
  });
});
