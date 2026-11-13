import { describe, expect, it } from "vitest";
import { displayTicker, isAsciiTicker, normalizeTicker, tickerSearchTerms } from "./ticker";

describe("normalizeTicker", () => {
  // [input, hasil yang diharapkan, keterangan]
  const table: Array<[string, string, string]> = [
    // huruf besar/kecil, spasi, tanda baca
    ["PEPE", "pepe", "dasar"],
    ["pepe", "pepe", "huruf kecil"],
    ["PePe", "pepe", "campuran"],
    [" PEPE ", "pepe", "spasi di tepi"],
    ["PE PE", "pepe", "spasi di tengah"],
    ["P.E-P_E", "pepe", "tanda baca"],
    ["$PEPE", "pepe", "sigil $ di depan"],
    ["$$PEPE", "pepe", "sigil $ ganda"],
    // leetspeak
    ["P3P3", "pepe", "3 → E"],
    ["B0NK", "bonk", "0 → O"],
    ["W1F", "wif", "1 → I"],
    ["4PE", "ape", "4 → A"],
    ["5HIB", "shib", "5 → S"],
    ["7RUMP", "trump", "7 → T"],
    ["8ONK", "bonk", "8 → B"],
    ["DO6E", "doge", "6 → G"],
    ["DO9E", "doge", "9 → G"],
    ["2EBRA", "zebra", "2 → Z"],
    ["@PE", "ape", "@ → A"],
    ["PEPE$", "pepes", "$ di akhir → S"],
    ["DOG!", "dogi", "! → I"],
    // kelas l / I / 1 / | disatukan
    ["LINK", "iink", "l → i"],
    ["L1NK", "iink", "1 setara L"],
    ["1INK", "iink", "1 setara I"],
    ["|INK", "iink", "| setara I"],
    ["BILL", "biii", "I dan L sama"],
    // homoglyph Unicode
    ["РЕРЕ", "pepe", "Cyrillic Р/Е"],
    ["PЕPE", "pepe", "satu huruf Cyrillic"],
    ["ВОNК", "bonk", "Cyrillic В/О/К"],
    ["ΑΡΕ", "ape", "Greek Α/Ρ/Ε"],
    ["ꓑꓰꓑꓰ", "pepe", "huruf Lisu"],
    ["ᏢEPE", "epe", "huruf di luar tabel dibuang (lapisan kedua: isAsciiTicker)"],
    ["ＰＥＰＥ", "pepe", "full-width (NFKC)"],
    ["𝐏𝐄𝐏𝐄", "pepe", "huruf tebal matematis (NFKC)"],
    ["PÉPÉ", "pepe", "diakritik"],
    ["P​EPE", "pepe", "zero-width space"],
    ["PEPE🐸", "pepe", "emoji dibuang"],
    ["ΡΕΡΕ", "pepe", "Greek Ρ/Ε"],
    ["ѕніb", "shib", "Cyrillic kecil ѕ/н/і"],
    // kombinasi
    ["$ P3Р3 ", "pepe", "sigil + spasi + leet + Cyrillic"],
    ["ВØNK", "bonk", "Cyrillic + Ø"],
    // ticker yang memang berbeda tetap berbeda
    ["PEPU", "pepu", "berbeda"],
    ["DOGE", "doge", "berbeda"],
  ];

  it.each(table)("%s → %s (%s)", (input, expected) => {
    expect(normalizeTicker(input)).toBe(expected);
  });

  it("varian copycat menghasilkan bentuk yang sama", () => {
    const variants = ["PEPE", "pepe", "P3P3", "РЕРЕ", "$pe pe", "ＰＥＰＥ", "PÉPE", "p.e.p.e"];
    expect(new Set(variants.map(normalizeTicker))).toEqual(new Set(["pepe"]));
  });

  it("idempoten", () => {
    for (const [input] of table) {
      const once = normalizeTicker(input);
      expect(normalizeTicker(once)).toBe(once);
    }
  });
});

describe("isAsciiTicker / displayTicker", () => {
  it.each([
    ["PEPE", true],
    ["$PEPE", true],
    ["P3P3", true],
    ["РЕРЕ", false],
    ["PE PE", false],
    ["PÉPE", false],
  ])("isAsciiTicker(%s) = %s", (input, expected) => {
    expect(isAsciiTicker(input)).toBe(expected);
  });

  it("displayTicker", () => {
    expect(displayTicker(" $pepe ")).toBe("PEPE");
  });
});

describe("tickerSearchTerms", () => {
  it.each([
    ["BONK", ["BONK"]],
    ["B0NK", ["B0NK", "BONK"]],
    ["L1NK", ["L1NK", "LINK", "LLNK"]],
    ["$р3ре", ["Р3РЕ", "PEPE"]],
  ])("%s → %j", (input, expected) => {
    expect(tickerSearchTerms(input)).toEqual(expected);
  });
});
