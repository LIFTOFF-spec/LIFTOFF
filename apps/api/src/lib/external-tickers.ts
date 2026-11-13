/**
 * Cek ticker yang sudah diperdagangkan DI LUAR LIFTOFF dengan likuiditas nyata (P4).
 *
 * Sumber publik: Jupiter Tokens API v2 (`/tokens/v2/search`), yang memuat simbol dan
 * likuiditas USD token Solana mainnet. Ticker dibandingkan setelah normalisasi yang sama
 * dengan ticker LIFTOFF. Jika sumber tidak bisa dihubungi, hasilnya `unavailable` dan
 * pemanggil menerapkan kebijakan fallback dari config (default: tolak).
 */
import { normalizeTicker, tickerSearchTerms } from "@liftoff/shared";
import type { KvStore } from "./kv";

export interface ExternalMatch {
  symbol: string;
  name: string;
  mint: string;
  liquidityUsd: number;
}

export type ExternalLookup =
  | { status: "clear" }
  | { status: "found"; matches: ExternalMatch[] }
  | { status: "unavailable"; error: string };

export interface ExternalTickerSource {
  readonly name: string;
  lookup(rawTicker: string, minLiquidityUsd: number): Promise<ExternalLookup>;
}

interface JupiterToken {
  id?: string;
  symbol?: string;
  name?: string;
  liquidity?: number | null;
}

export class JupiterTickerSource implements ExternalTickerSource {
  readonly name = "jupiter";

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly kv: KvStore | null = null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async lookup(rawTicker: string, minLiquidityUsd: number): Promise<ExternalLookup> {
    const normalized = normalizeTicker(rawTicker);
    const cacheKey = `ext:jup:v2:${normalized}:${minLiquidityUsd}`;
    const cached = await this.kv?.get(cacheKey).catch(() => null);
    if (cached) return JSON.parse(cached) as ExternalLookup;

    // Cari dengan beberapa varian (mis. "B0NK" → juga "BONK"); dedup per mint.
    const byMint = new Map<string, JupiterToken>();
    for (const term of tickerSearchTerms(rawTicker)) {
      try {
        const url = new URL("/tokens/v2/search", this.baseUrl);
        url.searchParams.set("query", term);
        const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs) });
        if (!res.ok) return { status: "unavailable", error: `HTTP ${res.status}` };
        const body = (await res.json()) as unknown;
        if (!Array.isArray(body)) return { status: "unavailable", error: "unexpected response" };
        for (const t of body as JupiterToken[]) byMint.set(t.id ?? `${t.symbol}:${byMint.size}`, t);
      } catch (err) {
        return { status: "unavailable", error: (err as Error).name || "fetch failed" };
      }
    }
    const tokens = [...byMint.values()];

    const matches = tokens
      .filter((t) => typeof t.symbol === "string" && normalizeTicker(t.symbol) === normalized)
      .filter((t) => (t.liquidity ?? 0) >= minLiquidityUsd)
      .map((t) => ({
        symbol: t.symbol!,
        name: t.name ?? "",
        mint: t.id ?? "",
        liquidityUsd: Math.round(t.liquidity ?? 0),
      }))
      .sort((a, b) => b.liquidityUsd - a.liquidityUsd);

    const result: ExternalLookup = matches.length
      ? { status: "found", matches }
      : { status: "clear" };
    await this.kv?.set(cacheKey, JSON.stringify(result), 10 * 60).catch(() => undefined);
    return result;
  }
}

/** Sumber statis untuk test & development offline. */
export class StaticTickerSource implements ExternalTickerSource {
  readonly name = "static";

  constructor(
    private readonly tokens: ExternalMatch[],
    private readonly available = true,
  ) {}

  async lookup(rawTicker: string, minLiquidityUsd: number): Promise<ExternalLookup> {
    if (!this.available) return { status: "unavailable", error: "source offline" };
    const normalized = normalizeTicker(rawTicker);
    const matches = this.tokens.filter(
      (t) => normalizeTicker(t.symbol) === normalized && t.liquidityUsd >= minLiquidityUsd,
    );
    return matches.length ? { status: "found", matches } : { status: "clear" };
  }
}
