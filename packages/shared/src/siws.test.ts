import { describe, expect, it } from "vitest";
import { base58Decode, base58Encode, buildSiwsMessage, isSolanaAddress } from "./siws";

describe("base58", () => {
  it.each([
    [[], ""],
    [[0], "1"],
    [[0, 0, 1], "112"],
    [[255], "5Q"],
    [[1, 2, 3, 4, 5], "7bWpTW"],
  ])("%j ↔ %s", (bytes, text) => {
    expect(base58Encode(Uint8Array.from(bytes))).toBe(text);
    expect([...base58Decode(text)]).toEqual(bytes);
  });

  it("round-trip public key nyata (System Program = 32 byte nol)", () => {
    const zeros = new Uint8Array(32);
    expect(base58Encode(zeros)).toBe("11111111111111111111111111111111");
    expect(base58Decode("So11111111111111111111111111111111111111112")).toHaveLength(32);
  });

  it("menolak karakter di luar alfabet", () => {
    expect(() => base58Decode("0OIl")).toThrow();
  });
});

describe("isSolanaAddress", () => {
  it.each([
    ["4xU25ckRqi5aeRZsAvZotvBCRcyQH3rvdPN3x5pgmCFj", true],
    ["So11111111111111111111111111111111111111112", true],
    ["not-a-wallet", false],
    ["legacy:abc", false],
    ["1111", false],
  ])("%s → %s", (value, expected) => {
    expect(isSolanaAddress(value)).toBe(expected);
  });
});

describe("buildSiwsMessage", () => {
  it("memuat wallet, nonce, cluster, dan menyatakan tidak ada transaksi", () => {
    const msg = buildSiwsMessage({
      domain: "localhost:3000",
      wallet: "4xU25ckRqi5aeRZsAvZotvBCRcyQH3rvdPN3x5pgmCFj",
      uri: "http://localhost:3000",
      cluster: "devnet",
      nonce: "abc123",
      issuedAt: "2026-10-28T00:00:00.000Z",
      expirationTime: "2026-10-28T00:10:00.000Z",
    });
    expect(msg.split("\n")[1]).toBe("4xU25ckRqi5aeRZsAvZotvBCRcyQH3rvdPN3x5pgmCFj");
    expect(msg).toContain("Nonce: abc123");
    expect(msg).toContain("Chain ID: devnet");
    expect(msg).toContain("does not send a transaction");
  });

  it('memakai Chain ID "mainnet" dari spec SIWS untuk cluster mainnet-beta', () => {
    const msg = buildSiwsMessage({
      domain: "liftoff.test",
      wallet: "4xU25ckRqi5aeRZsAvZotvBCRcyQH3rvdPN3x5pgmCFj",
      uri: "https://liftoff.test",
      cluster: "mainnet-beta",
      nonce: "abc123",
      issuedAt: "2026-10-28T00:00:00.000Z",
      expirationTime: "2026-10-28T00:10:00.000Z",
    });
    expect(msg.split("\n")).toContain("Chain ID: mainnet");
  });
});
