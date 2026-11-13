import type { Pair } from "@liftoff/shared";
import { describe, expect, it } from "vitest";
import { pairLabel } from "./format";
import { filterPairs } from "./pair-search";

const pair = (over: Partial<Pair>): Pair =>
  ({
    id: "x",
    symbol: "SOL",
    name: "Solana",
    mint: "So11111111111111111111111111111111111111112",
    category: "solana",
    categoryLabel: "Solana",
    ...over,
  }) as Pair;

describe("filterPairs", () => {
  const list = [
    pair({}),
    pair({ symbol: "ANSEM", name: "The Black Bull", mint: "9cRCabc", category: "custom" }),
    pair({ symbol: "ANSEM", name: "Ansem Other", mint: "7xyzdef", category: "custom" }),
    pair({
      symbol: "SPYX",
      name: "SP500",
      mint: "XsoCS1",
      category: "xstock",
      categoryLabel: "xStock",
    }),
  ];

  it("mencari simbol, nama, mint, kategori tanpa beda huruf besar", () => {
    expect(filterPairs(list, "ansem", "")).toHaveLength(2);
    expect(filterPairs(list, "BLACK", "")).toHaveLength(1);
    expect(filterPairs(list, "7xyz", "")[0]!.name).toBe("Ansem Other");
    expect(filterPairs(list, "xstock", "")[0]!.symbol).toBe("SPYX");
    expect(filterPairs(list, "ansem other", "")).toHaveLength(1);
    expect(filterPairs(list, "tidakada", "")).toEqual([]);
    expect(filterPairs(list, "  ", "")).toHaveLength(4);
  });

  it("filter kategori", () => {
    expect(filterPairs(list, "", "custom")).toHaveLength(2);
    expect(filterPairs(list, "spy", "custom")).toEqual([]);
  });
});

describe("pairLabel", () => {
  const u = (symbol: string, mint: string, name = symbol) => ({ id: mint, symbol, name, mint });

  it("simbol unik tanpa pembeda", () => {
    expect(pairLabel(u("SOL", "A"), [u("SOL", "A"), u("USDC", "B")])).toBe("/SOL");
  });

  it("satu mint beda config memakai nama config; beda mint memakai mint singkat", () => {
    const a = u("SOL", "So11", "Solana (config 0)");
    const b = u("SOL", "So11", "Solana (config 1)");
    expect(pairLabel(b, [a, b])).toBe("/SOL (config 1)");
    const c = u("ANSEM", "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump");
    const d = u("ANSEM", "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W");
    expect(pairLabel(c, [c, d])).toBe("/ANSEM (9cRC…pump)");
  });
});
