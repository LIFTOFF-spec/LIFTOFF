import { describe, expect, it } from "vitest";
import { allocateCreatorFee, assertValidFeeConfig, FEE_CONFIG, type FeeConfig } from "./fee-config";

describe("FEE_CONFIG (Spec §9–10)", () => {
  it("model Spec: creator fee 50 bps, platform fee StonkFun 100 bps, referral 0, 80/20", () => {
    expect(FEE_CONFIG.status).toBe("verified");
    expect(FEE_CONFIG.platformFeeBps).toBe(100);
    expect(FEE_CONFIG.creatorFeeBps).toBe(50);
    expect(FEE_CONFIG.expectedCpmmCreatorFeeBps).toBe(25);
    expect(FEE_CONFIG.referralFeeBps).toBe(0);
    expect(FEE_CONFIG.split).toEqual({ buybackBurn: 8_000, convictionReserve: 2_000 });
    expect(FEE_CONFIG.roundingRemainderTo).toBe("buybackBurn");
    // Tidak ada porsi treasury sama sekali.
    expect(Object.keys(FEE_CONFIG.split)).toEqual(["buybackBurn", "convictionReserve"]);
  });

  it("valid dan total split = 10_000 bps", () => {
    expect(() => assertValidFeeConfig(FEE_CONFIG)).not.toThrow();
  });

  it("menolak split yang totalnya bukan 10_000 bps", () => {
    const bad: FeeConfig = {
      ...FEE_CONFIG,
      split: { buybackBurn: 8_000, convictionReserve: 1_000 },
    };
    expect(() => assertValidFeeConfig(bad)).toThrow(/total split/);
  });

  it("menolak nilai negatif atau pecahan", () => {
    expect(() => assertValidFeeConfig({ ...FEE_CONFIG, platformFeeBps: -1 })).toThrow();
    expect(() => assertValidFeeConfig({ ...FEE_CONFIG, creatorFeeBps: 1.5 })).toThrow();
  });

  it("menolak fee di atas batas program LaunchLab", () => {
    expect(() => assertValidFeeConfig({ ...FEE_CONFIG, platformFeeBps: 500 })).not.toThrow();
    expect(() => assertValidFeeConfig({ ...FEE_CONFIG, platformFeeBps: 501 })).toThrow(/maks 500/);
    expect(() => assertValidFeeConfig({ ...FEE_CONFIG, creatorFeeBps: 51 })).toThrow(/maks 50/);
  });
});

describe("allocateCreatorFee (aritmatika integer 80/20)", () => {
  it("contoh Spec: 1000 → 800 / 200, 5000 → 4000 / 1000", () => {
    expect(allocateCreatorFee(1_000n)).toEqual({ buybackBurn: 800n, convictionReserve: 200n });
    expect(allocateCreatorFee(5_000n)).toEqual({ buybackBurn: 4_000n, convictionReserve: 1_000n });
  });

  it("sisa pembulatan masuk Buyback & Burn; jumlah selalu = amount", () => {
    expect(allocateCreatorFee(0n)).toEqual({ buybackBurn: 0n, convictionReserve: 0n });
    expect(allocateCreatorFee(1n)).toEqual({ buybackBurn: 1n, convictionReserve: 0n });
    expect(allocateCreatorFee(4n)).toEqual({ buybackBurn: 4n, convictionReserve: 0n });
    expect(allocateCreatorFee(9n)).toEqual({ buybackBurn: 8n, convictionReserve: 1n });
    for (const n of [2n, 3n, 7n, 13n, 99n, 12_345n, 2n ** 63n - 1n]) {
      const a = allocateCreatorFee(n);
      expect(a.buybackBurn + a.convictionReserve).toBe(n);
      // Reserve tidak pernah melebihi 20%; buyback tidak pernah kurang dari 80%.
      expect(a.convictionReserve * 10_000n).toBeLessThanOrEqual(n * 2_000n);
      expect(a.buybackBurn * 10_000n).toBeGreaterThanOrEqual(n * 8_000n);
      expect(a.buybackBurn * 10_000n - n * 8_000n).toBeLessThan(10_000n);
    }
  });

  it("menolak amount negatif dan split tidak valid", () => {
    expect(() => allocateCreatorFee(-1n)).toThrow(/negatif/);
    expect(() => allocateCreatorFee(10n, { buybackBurn: 1, convictionReserve: 1 })).toThrow();
  });
});
