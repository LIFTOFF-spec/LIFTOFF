import { describe, expect, it } from "vitest";
import { raydiumAuthoritiesFor } from "@liftoff/shared";
import { countHolders, lpDistribution } from "./market";
import { tradePriceAfter } from "./receipt";

const AUTH = raydiumAuthoritiesFor("devnet");
import { programDataLogs } from "./trade";

const CPMM = "DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb";

describe("programDataLogs", () => {
  it("hanya mengambil `Program data:` yang di-emit langsung oleh program CPMM", () => {
    const real = Buffer.from("real").toString("base64");
    const fake = Buffer.from("fake").toString("base64");
    const logs = [
      "Program Evil111111111111111111111111111111111 invoke [1]",
      `Program data: ${fake}`,
      `Program ${CPMM} invoke [2]`,
      "Program log: Instruction: SwapBaseInput",
      `Program data: ${real}`,
      `Program ${CPMM} success`,
      `Program data: ${fake}`,
      "Program Evil111111111111111111111111111111111 success",
    ];
    expect(programDataLogs(logs, CPMM).map((b) => b.toString())).toEqual(["real"]);
  });
});

describe("holder & LP", () => {
  it("holder = owner unik bersaldo > 0, tanpa vault pool", () => {
    expect(
      countHolders(
        [
          { address: "1", owner: "A", amount: 1n },
          { address: "2", owner: "A", amount: 3n },
          { address: "3", owner: "B", amount: 0n },
          { address: "4", owner: AUTH.launchlab, amount: 9n },
          { address: "5", owner: AUTH.cpmm, amount: 9n },
        ],
        [AUTH.launchlab, AUTH.cpmm],
      ),
    ).toBe(1);
  });

  it("distribusi LP $LFTGRD (PoC Tahap 1): 50% dibakar, sisanya dikunci, 0 bebas", () => {
    const lp = lpDistribution(
      143_840_189_098n,
      71_920_094_499n,
      [{ address: "2wQy", owner: AUTH.lockCpmm, amount: 71_920_094_499n }],
      AUTH.lockCpmm,
    );
    expect(lp).toEqual({
      total: 143_840_189_098n,
      burned: 71_920_094_599n,
      locked: 71_920_094_499n,
      free: 0n,
    });
  });
});

describe("tradePriceAfter", () => {
  it("harga curve sesudah trade dari TradeEvent", () => {
    const price = tradePriceAfter(
      {
        signature: "s",
        slot: 1,
        wallet: "w",
        failed: false,
        cpmm: null,
        tokenDeltas: [],
        launchlab: {
          pool: "p",
          amountIn: 0n,
          amountOut: 0n,
          protocolFee: 0n,
          platformFee: 0n,
          creatorFee: 0n,
          shareFee: 0n,
          direction: 0,
          poolStatus: 0,
          virtualBase: 1_073_025_609_049_470n,
          virtualQuote: 35_295_121n,
          realBaseAfter: 793_100_000_000_000n,
          realQuoteAfter: 100_000_000n,
        },
      },
      "So11111111111111111111111111111111111111112",
      9,
    );
    expect(price?.startsWith("0.00000000048332")).toBe(true);
  });
});
