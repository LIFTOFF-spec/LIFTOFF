import { describe, expect, it } from "vitest";
import { pairsFor } from "./pairs";
import { curveParamsFor, platformFor, STONKFUN_MAINNET } from "./platform";
import pricingFixture from "./__fixtures__/stonkfun/pricing-sol-mainnet-2026-10-31.json";

describe("curveParamsFor", () => {
  const pairs = Object.fromEntries(pairsFor("devnet").map((p) => [p.id, p]));

  it("SOL: $12.000 / $150 = 80 SOL, supply 1e15, jual 79,31%", () => {
    const c = curveParamsFor(pairs.sol!);
    expect(c.totalFundRaisingB).toBe(80_000_000_000n);
    expect(c.supply).toBe(1_000_000_000_000_000n);
    expect(c.totalSellA).toBe(793_100_000_000_000n);
  });

  it("USDC 12.000, RAY 6.000 (sama dengan launch PoC)", () => {
    expect(curveParamsFor(pairs.usdc!).totalFundRaisingB).toBe(12_000_000_000n);
    expect(curveParamsFor(pairs.ray!).totalFundRaisingB).toBe(6_000_000_000n);
  });

  it("tidak pernah di bawah minFundRaisingB config", () => {
    const pair = { ...pairs["sol-1"]!, assumedPriceUsd: 10_000 };
    expect(curveParamsFor(pair).totalFundRaisingB).toBe(30_000_000_000n);
  });

  it("platform devnet tetap; env master tidak mengubah devnet", () => {
    const p = platformFor("devnet", { MASTER_WALLET_PUBKEY: MAINNET_MASTER });
    expect(p.platformId).toBe("21vCqsaZhkK8NY1DmPQJuD3bLxjGCeLHbLZrbHpjxozE");
    expect(p.masterWallet).toBe("4xU25ckRqi5aeRZsAvZotvBCRcyQH3rvdPN3x5pgmCFj");
  });
});

// Pubkey acak untuk uji (bukan wallet siapa pun).
const MAINNET_MASTER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

describe("platform mainnet (Tahap 11a)", () => {
  it("platform standard StonkFun + program LaunchLab mainnet", () => {
    const p = platformFor("mainnet-beta", { MASTER_WALLET_PUBKEY: MAINNET_MASTER });
    expect(p.launchlabProgram).toBe("LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj");
    expect(p.platformId).toBe("4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7");
    expect(p.masterWallet).toBe(MAINNET_MASTER);
  });

  it("master wallet mainnet wajib dari env dan harus pubkey", () => {
    expect(() => platformFor("mainnet-beta", {})).toThrow(/MASTER_WALLET_PUBKEY/);
    expect(() => platformFor("mainnet-beta", { MASTER_WALLET_PUBKEY: "[1,2,3]" })).toThrow();
    expect(() => platformFor("testnet", { MASTER_WALLET_PUBKEY: MAINNET_MASTER })).toThrow();
  });

  it("cocok dengan respons pricing asli StonkFun", () => {
    const f = pricingFixture.data;
    expect(STONKFUN_MAINNET.launchlabProgram).toBe(f.curve.programId);
    expect(STONKFUN_MAINNET.platformStandard).toBe(f.platform.standard);
    expect(STONKFUN_MAINNET.sol.configId).toBe(f.curve.configId);
    expect(STONKFUN_MAINNET.sol.allowConfigId).toBe(f.allowConfig.standard);
    expect(STONKFUN_MAINNET.sol.curveRuleId).toBe(f.curveRule.standard);
    const sol = pairsFor("mainnet-beta").find((p) => p.id === "sol")!;
    expect(sol.configId).toBe(f.curve.configId);
    expect(sol.mint).toBe(f.quote.mint);
    expect(sol.decimals).toBe(f.quote.decimals);
    expect(sol.minFundRaisingRaw).toBe(f.raise.minimumRaw);
  });
});
