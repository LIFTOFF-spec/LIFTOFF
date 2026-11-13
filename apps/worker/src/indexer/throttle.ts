/** Jeda minimum antar panggilan RPC (berurutan), untuk rate limit RPC publik devnet. */
export class RateLimiter {
  private next = 0;

  constructor(
    private readonly minIntervalMs: number,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  async wait(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.minIntervalMs;
    if (at > now) await this.sleep(at - now);
  }
}

/** Backoff eksponensial: reset() setelah siklus sukses, fail() mengembalikan jeda berikutnya. */
export class Backoff {
  private current = 0;

  constructor(
    private readonly initialMs: number,
    private readonly maxMs: number,
  ) {}

  fail(): number {
    this.current = this.current === 0 ? this.initialMs : Math.min(this.current * 2, this.maxMs);
    return this.current;
  }

  reset(): void {
    this.current = 0;
  }
}

/** Error yang berarti RPC kelebihan beban / tidak terjangkau → hentikan siklus & backoff. */
export function isRpcPressure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b429\b|too many requests|rate limit|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|\b50[234]\b/i.test(
    msg,
  );
}
