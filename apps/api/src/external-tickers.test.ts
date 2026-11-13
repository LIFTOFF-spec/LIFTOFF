import { describe, expect, it } from "vitest";
import { JupiterTickerSource } from "./lib/external-tickers";
import { MemoryKvStore } from "./lib/kv";

/** Jupiter palsu: mengembalikan token yang simbolnya mengandung query (seperti pencarian aslinya). */
function fakeJupiter(tokens: Array<{ id: string; symbol: string; liquidity: number }>) {
  const queries: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const q = new URL(String(input)).searchParams.get("query") ?? "";
    queries.push(q);
    return Response.json(tokens.filter((t) => t.symbol.toUpperCase().includes(q.toUpperCase())));
  };
  return { fetchImpl, queries };
}

describe("JupiterTickerSource", () => {
  const tokens = [
    { id: "bonk-mint", symbol: "Bonk", liquidity: 6_000_000 },
    { id: "tiny-mint", symbol: "TINY", liquidity: 10 },
  ];

  it("menemukan varian leetspeak lewat kata kunci tambahan dan menghormati threshold", async () => {
    const { fetchImpl, queries } = fakeJupiter(tokens);
    const source = new JupiterTickerSource(
      "https://jup.test",
      1000,
      new MemoryKvStore(),
      fetchImpl,
    );
    const found = await source.lookup("B0NK", 10_000);
    expect(found).toMatchObject({
      status: "found",
      matches: [{ symbol: "Bonk", liquidityUsd: 6_000_000 }],
    });
    expect(queries).toEqual(["B0NK", "BONK"]);
    expect(await source.lookup("TINY", 10_000)).toEqual({ status: "clear" });
  });

  it("hasil di-cache; sumber error → unavailable (bukan clear)", async () => {
    const { fetchImpl, queries } = fakeJupiter(tokens);
    const source = new JupiterTickerSource(
      "https://jup.test",
      1000,
      new MemoryKvStore(),
      fetchImpl,
    );
    await source.lookup("BONK", 10_000);
    await source.lookup("bonk", 10_000);
    expect(queries).toEqual(["BONK"]);

    const down = new JupiterTickerSource(
      "https://jup.test",
      1000,
      null,
      async () => new Response("", { status: 502 }),
    );
    expect(await down.lookup("BONK", 10_000)).toMatchObject({ status: "unavailable" });
    const offline = new JupiterTickerSource("https://jup.test", 1000, null, async () => {
      throw new TypeError("fetch failed");
    });
    expect(await offline.lookup("BONK", 10_000)).toMatchObject({ status: "unavailable" });
  });
});
