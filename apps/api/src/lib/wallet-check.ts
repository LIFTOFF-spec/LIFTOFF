/**
 * Syarat minimum wallet untuk launch (anti-spam, D9 revisi): saldo SOL minimum dan/atau umur
 * wallet. Saldo hanya DIBACA lewat RPC, tidak pernah dipotong. Jika RPC tidak bisa dihubungi,
 * hasilnya `unavailable` dan launch ditolak (fail-closed, karena treasury yang membayar).
 */
import type { WalletRequirementsConfig } from "@liftoff/shared";

export type WalletCheck =
  | { status: "ok" }
  | { status: "failed"; code: "wallet_low_balance" | "wallet_too_new"; message: string }
  | { status: "unavailable"; error: string };

export interface WalletChecker {
  check(wallet: string, req: WalletRequirementsConfig): Promise<WalletCheck>;
}

const LAMPORTS_PER_SOL = 1_000_000_000;
const DAY_SECONDS = 86_400;
/** Batas halaman getSignaturesForAddress (1000 per halaman) untuk mencari transaksi tertua. */
const MAX_SIGNATURE_PAGES = 5;

export const formatSol = (lamports: number) =>
  (lamports / LAMPORTS_PER_SOL).toFixed(9).replace(/\.?0+$/, "");

export class RpcWalletChecker implements WalletChecker {
  constructor(
    private readonly rpcUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const res = await this.fetchImpl(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.error || body.result === undefined)
      throw new Error(body.error?.message ?? "RPC error");
    return body.result;
  }

  /** Umur wallet dalam detik berdasarkan transaksi tertua; `Infinity` jika riwayat sangat panjang. */
  private async ageSeconds(wallet: string): Promise<number> {
    let before: string | undefined;
    let oldest: number | null = null;
    for (let page = 0; page < MAX_SIGNATURE_PAGES; page++) {
      const sigs = await this.rpc<Array<{ signature: string; blockTime: number | null }>>(
        "getSignaturesForAddress",
        [wallet, { limit: 1000, ...(before ? { before } : {}) }],
      );
      if (sigs.length === 0) break;
      const last = sigs[sigs.length - 1]!;
      if (last.blockTime) oldest = last.blockTime;
      if (sigs.length < 1000) break;
      before = last.signature;
      if (page === MAX_SIGNATURE_PAGES - 1) return Infinity;
    }
    return oldest === null ? 0 : this.now() / 1000 - oldest;
  }

  async check(wallet: string, req: WalletRequirementsConfig): Promise<WalletCheck> {
    try {
      if (req.minBalanceLamports > 0) {
        const balance = await this.rpc<{ value: number }>("getBalance", [
          wallet,
          { commitment: "confirmed" },
        ]);
        if (balance.value < req.minBalanceLamports) {
          return {
            status: "failed",
            code: "wallet_low_balance",
            message: `This wallet needs at least ${formatSol(req.minBalanceLamports)} SOL (only checked, never charged). Current balance: ${formatSol(balance.value)} SOL.`,
          };
        }
      }
      if (req.minAgeDays > 0 && (await this.ageSeconds(wallet)) < req.minAgeDays * DAY_SECONDS) {
        return {
          status: "failed",
          code: "wallet_too_new",
          message: `This wallet must be at least ${req.minAgeDays} days old (first transaction).`,
        };
      }
      return { status: "ok" };
    } catch (err) {
      return { status: "unavailable", error: (err as Error).message };
    }
  }
}

/** Untuk test: hasil tetap per wallet (default ok). */
export class StaticWalletChecker implements WalletChecker {
  constructor(private readonly results: Record<string, WalletCheck> = {}) {}

  async check(wallet: string): Promise<WalletCheck> {
    return this.results[wallet] ?? { status: "ok" };
  }
}
