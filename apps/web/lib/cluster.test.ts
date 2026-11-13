import { describe, expect, it } from "vitest";
import { explorerUrl } from "./format";
import { clusterCopy, clusterLabel } from "./cluster";

describe("clusterLabel", () => {
  it("tautan explorer mengikuti cluster aktif", () => {
    const before = process.env.NEXT_PUBLIC_SOLANA_CLUSTER;
    process.env.NEXT_PUBLIC_SOLANA_CLUSTER = "mainnet-beta";
    expect(explorerUrl("tx", "abc")).toBe("https://explorer.solana.com/tx/abc");
    process.env.NEXT_PUBLIC_SOLANA_CLUSTER = "devnet";
    expect(explorerUrl("tx", "abc")).toBe("https://explorer.solana.com/tx/abc?cluster=devnet");
    if (before === undefined) delete process.env.NEXT_PUBLIC_SOLANA_CLUSTER;
    else process.env.NEXT_PUBLIC_SOLANA_CLUSTER = before;
  });

  it("seluruh teks mainnet bebas devnet/MOCK/faucet dan bebas janji", () => {
    const copy = Object.values(clusterCopy("mainnet-beta")).filter(Boolean).join("\n");
    expect(copy).not.toMatch(/devnet|testnet|MOCK|faucet|emulat|test token|prototype/i);
    expect(copy).not.toMatch(/assumed pair price/i);
    // Klaim terlarang: hanya boleh muncul sebagai penyangkalan.
    expect(copy.replace(/not sniper-proof/g, "")).not.toMatch(/sniper-proof/i);
    expect(copy).not.toMatch(/guaranteed price|price is guaranteed|permanently locked/i);
    expect(copy).not.toMatch(/nobody else can buy|kept out of the token/i);
  });

  it("teks mainnet menyebut USD sebagai estimasi, kembali ke pair asset saat tak terverifikasi, dan syarat pair", () => {
    const c = clusterCopy("mainnet-beta");
    expect(c.footer).toMatch(/estimates at the current price of the pair asset/);
    expect(c.footer).toMatch(/shown in the pair asset while that price cannot be verified/);
    expect(c.usdEstimateTitle).toMatch(/Estimated.*Jupiter/);
    expect(c.reserveDeploymentStatus).toMatch(/only while the price of the pair asset is verified/);
    for (const text of [c.faqPairs, c.howPairs, c.createPairsIntro]) {
      expect(text).toMatch(/live from StonkFun/);
      expect(text).toMatch(/launchable, LaunchLab-ready and open on LIFTOFF/);
    }
    expect(Object.values(c).join(" ")).not.toMatch(/SPYx|live price source/);
  });

  it("teks devnet tidak berubah kata kuncinya (emulasi, MOCK, tanpa bundle)", () => {
    const c = clusterCopy("devnet");
    expect(c.footer).toContain("(devnet)");
    expect(c.footer).toContain("MOCK");
    expect(c.dependencyNote).toContain("stands in");
    expect(c.faqStonkfun).toMatch(/^Not on devnet/);
    expect(c.createSniper).toContain("On devnet there are no private bundles");
    expect(c.feeVerifiedTag).toBe("Verified on devnet");
    expect(c.feeCaveat).toBeNull();
  });

  it("devnet tetap DEVNET", () => {
    const l = clusterLabel("devnet");
    expect(l.badge).toBe("DEVNET");
    expect(l.tone).toBe("devnet");
    expect(l.notice).toContain("devnet");
  });

  it("mainnet = MAINNET BETA dengan peringatan uang asli", () => {
    const l = clusterLabel("mainnet-beta");
    expect(l.badge).toBe("MAINNET BETA");
    expect(l.tone).toBe("beta");
    expect(l.notice).toMatch(/real funds/);
    expect(l.notice).not.toMatch(/devnet|MOCK/);
  });

  it("tidak pernah menjanjikan anti-sniper, harga, atau LP terkunci", () => {
    for (const c of ["devnet", "testnet", "mainnet-beta"] as const) {
      const text = `${clusterLabel(c).notice} ${clusterLabel(c).title}`.toLowerCase();
      expect(text).not.toMatch(/(?<!not )sniper-proof|guaranteed price|permanently locked/);
    }
    expect(clusterLabel("mainnet-beta").notice).toMatch(/not sniper-proof/);
    expect(clusterLabel("mainnet-beta").notice).toMatch(/not guaranteed/);
    expect(clusterLabel("mainnet-beta").notice).toMatch(/only when the lock is shown on-chain/);
  });
});
