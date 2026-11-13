import { describe, expect, it } from "vitest";
import { WSOL_MINT } from "./pairs";
import { SOL_PRICE_CONFIG } from "./sol-price";
import { createSolPriceOracle } from "./stonkfun-api";

/**
 * Uji baca-saja ke API asli StonkFun & Jupiter. Hanya GET, tanpa keypair dan tanpa transaksi. Tidak
 * ikut `pnpm test` biasa supaya test tetap jalan tanpa jaringan:
 *   LIFTOFF_LIVE_PRICE_TEST=1 pnpm --filter @liftoff/shared exec vitest run sol-price.live
 */
describe.skipIf(process.env.LIFTOFF_LIVE_PRICE_TEST !== "1")(
  "harga SOL/USD asli (baca saja)",
  () => {
    it("kedua sumber terbaca, segar, dan sejalan", { timeout: 30_000 }, async () => {
      const oracle = createSolPriceOracle("mainnet-beta", {
        config: SOL_PRICE_CONFIG,
        jupiterApiUrl: process.env.JUPITER_API_URL ?? "https://lite-api.jup.ag",
        stonkfunEnabled: true,
      })!;
      const p = await oracle.read();
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ mint: WSOL_MINT, ...p }));
      expect(p.issues).toEqual([]);
      expect(p.status).toBe("verified");
      expect(p.usd).toBeGreaterThan(0);
      expect(p.ageSeconds).toBeLessThanOrEqual(SOL_PRICE_CONFIG.maxAgeSeconds);
      expect(p.deviationBps).toBeLessThanOrEqual(SOL_PRICE_CONFIG.maxDeviationBps);
    });
  },
);
