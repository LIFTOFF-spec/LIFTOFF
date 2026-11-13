import { describe, expect, it } from "vitest";
import {
  associatedTokenAddress,
  isAssociatedTokenAddressOf,
  parseMintAccount,
  readMintExtensions,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  tokenAccountSize,
  quoteAtaSize,
  quoteWarnings,
  unsupportedQuoteReason,
} from "./token-program";

const OWNER = "4xU25ckRqi5aeRZsAvZotvBCRcyQH3rvdPN3x5pgmCFj";
const MINT = "So11111111111111111111111111111111111111112";

/** Data mint Token-2022: 82 byte dasar, padding s/d 165, account type, lalu TLV ekstensi. */
function mint2022(exts: Array<[number, Buffer]>, decimals = 6, supply = 1_000n) {
  const base = Buffer.alloc(166);
  base.writeBigUInt64LE(supply, 36);
  base[44] = decimals;
  base[45] = 1;
  base[165] = 1; // AccountType::Mint
  const tlv = exts.map(([type, body]) => {
    const h = Buffer.alloc(4);
    h.writeUInt16LE(type, 0);
    h.writeUInt16LE(body.length, 2);
    return Buffer.concat([h, body]);
  });
  return Buffer.concat([base, ...tlv]);
}

function transferFee(olderBps: number, newerBps: number, newerEpoch: bigint) {
  const b = Buffer.alloc(108);
  b.writeUInt16LE(olderBps, 88);
  b.writeBigUInt64LE(newerEpoch, 90);
  b.writeUInt16LE(newerBps, 106);
  return b;
}

describe("program token", () => {
  it("ATA berbeda per program; pengecekan menerima keduanya", () => {
    const spl = associatedTokenAddress(OWNER, MINT, TOKEN_PROGRAM);
    const t22 = associatedTokenAddress(OWNER, MINT, TOKEN_2022_PROGRAM);
    expect(spl).not.toBe(t22);
    expect(isAssociatedTokenAddressOf(spl, OWNER, MINT)).toBe(true);
    expect(isAssociatedTokenAddressOf(t22, OWNER, MINT)).toBe(true);
    expect(isAssociatedTokenAddressOf(MINT, OWNER, MINT)).toBe(false);
    expect(tokenAccountSize(TOKEN_2022_PROGRAM)).toBe(170);
    expect(tokenAccountSize(TOKEN_PROGRAM)).toBe(165);
  });

  it("ekstensi Token-2022: transfer fee per epoch, hook, metadata diabaikan", () => {
    const metadataPointer: [number, Buffer] = [18, Buffer.alloc(64)];
    const fee = readMintExtensions(mint2022([metadataPointer, [1, transferFee(50, 100, 10n)]]), 12);
    expect(fee).toMatchObject({ transferFeeBps: 100, transferHook: false, types: [18, 1] });
    expect(readMintExtensions(mint2022([[1, transferFee(50, 100, 10n)]]), 5).transferFeeBps).toBe(
      50,
    );
    const plain = parseMintAccount(TOKEN_2022_PROGRAM, mint2022([metadataPointer]))!;
    expect(plain).toMatchObject({ program: TOKEN_2022_PROGRAM, decimals: 6, supply: 1_000n });
    expect(unsupportedQuoteReason(plain)).toBeNull();
    const taxed = parseMintAccount(TOKEN_2022_PROGRAM, mint2022([[1, transferFee(0, 25, 0n)]]))!;
    expect(unsupportedQuoteReason(taxed)).toMatch(/transfer fee/);
    // Hook aktif: program terisi. Ekstensi dengan program kosong (xStocks) tidak menjalankan apa pun.
    const hookProgram = Buffer.alloc(64);
    hookProgram.fill(7, 32);
    const hooked = parseMintAccount(TOKEN_2022_PROGRAM, mint2022([[14, hookProgram]]))!;
    expect(hooked.extensions).toMatchObject({ transferHook: true, transferHookInactive: false });
    expect(unsupportedQuoteReason(hooked)).toMatch(/hook/);
    const authorityOnly = Buffer.alloc(64);
    authorityOnly.fill(7, 0, 32);
    const inactive = parseMintAccount(TOKEN_2022_PROGRAM, mint2022([[14, authorityOnly]]))!;
    expect(inactive.extensions).toMatchObject({ transferHook: false, transferHookInactive: true });
    expect(unsupportedQuoteReason(inactive)).toBeNull();
    expect(quoteWarnings(inactive).join(" ")).toMatch(/turn on a transfer hook/);
    // Data ekstensi tidak utuh: dianggap aktif (gagal tertutup).
    const broken = parseMintAccount(TOKEN_2022_PROGRAM, mint2022([[14, Buffer.alloc(10)]]))!;
    expect(unsupportedQuoteReason(broken)).toMatch(/hook/);
    expect(parseMintAccount("11111111111111111111111111111111", Buffer.alloc(82))).toBeNull();
  });

  it("peringatan quote: permanent delegate, pausable, scaled amount (bentuk xStocks)", () => {
    const x = parseMintAccount(
      TOKEN_2022_PROGRAM,
      mint2022([
        [12, Buffer.alloc(32)],
        [25, Buffer.alloc(56)],
        [26, Buffer.alloc(33)],
        [14, Buffer.alloc(64)],
      ]),
    )!;
    expect(unsupportedQuoteReason(x)).toBeNull();
    const w = quoteWarnings(x).join(" ");
    expect(w).toMatch(/move or burn/);
    expect(w).toMatch(/freeze or pause/);
    expect(w).toMatch(/multiplied/);
    expect(quoteAtaSize(x)).toBe(179);
  });

  it("deposit 0,012 SOL menutup launch pair apa pun, termasuk ATA quote baru (BUILD_PLAN §7q)", () => {
    const rent = (size: number) => (128 + size) * 6960;
    const solLaunch = 9_524_080; // biaya nyata PunkDuck, sudah termasuk vault quote SPL 165 byte + tip
    const worst = quoteAtaSize(
      parseMintAccount(
        TOKEN_2022_PROGRAM,
        mint2022([
          [14, Buffer.alloc(64)],
          [26, Buffer.alloc(33)],
        ]),
      )!,
    );
    expect(worst).toBe(179);
    const extraVault = rent(worst) - rent(165); // vault quote pool lebih besar
    const quoteAta = rent(worst); // ATA quote master, sekali per quote
    expect(solLaunch + extraVault + quoteAta).toBeLessThanOrEqual(12_000_000);
    // Margin tipis: bila tip atau biaya naik, ukur ulang.
    expect(12_000_000 - (solLaunch + extraVault + quoteAta)).toBeLessThan(500_000);
  });
});
