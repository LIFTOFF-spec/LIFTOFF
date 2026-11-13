import { describe, expect, it } from "vitest";
import { RpcWalletChecker } from "./lib/wallet-check";

const WALLET = "4xU25ckRqi5aeRZsAvZotvBCRcyQH3rvdPN3x5pgmCFj";
const NOW = Date.parse("2026-10-28T00:00:00Z");

/** RPC palsu: saldo tetap + riwayat signature dengan blockTime tertentu. */
function fakeRpc(balance: number, oldestBlockTime: number | null) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const { method } = JSON.parse(String(init?.body)) as { method: string };
    calls.push(method);
    if (method === "getBalance") return Response.json({ result: { value: balance } });
    const sigs = oldestBlockTime === null ? [] : [{ signature: "s1", blockTime: oldestBlockTime }];
    return Response.json({ result: sigs });
  };
  return { fetchImpl, calls };
}

describe("RpcWalletChecker", () => {
  it("saldo cukup → ok; umur tidak dicek jika minAgeDays 0", async () => {
    const { fetchImpl, calls } = fakeRpc(60_000_000, null);
    const checker = new RpcWalletChecker("http://rpc", fetchImpl, () => NOW);
    expect(await checker.check(WALLET, { minBalanceLamports: 50_000_000, minAgeDays: 0 })).toEqual({
      status: "ok",
    });
    expect(calls).toEqual(["getBalance"]);
  });

  it("saldo kurang → wallet_low_balance dengan angka dari config", async () => {
    const checker = new RpcWalletChecker("http://rpc", fakeRpc(10_000_000, null).fetchImpl);
    const res = await checker.check(WALLET, { minBalanceLamports: 50_000_000, minAgeDays: 0 });
    expect(res).toMatchObject({ status: "failed", code: "wallet_low_balance" });
    expect(res.status === "failed" && res.message).toContain("0.05 SOL");
  });

  it("umur wallet: terlalu baru / cukup tua / tanpa riwayat", async () => {
    const req = { minBalanceLamports: 0, minAgeDays: 7 };
    const young = new RpcWalletChecker(
      "http://rpc",
      fakeRpc(0, NOW / 1000 - 86_400).fetchImpl,
      () => NOW,
    );
    expect(await young.check(WALLET, req)).toMatchObject({ code: "wallet_too_new" });
    const old = new RpcWalletChecker(
      "http://rpc",
      fakeRpc(0, NOW / 1000 - 30 * 86_400).fetchImpl,
      () => NOW,
    );
    expect(await old.check(WALLET, req)).toEqual({ status: "ok" });
    const fresh = new RpcWalletChecker("http://rpc", fakeRpc(0, null).fetchImpl, () => NOW);
    expect(await fresh.check(WALLET, req)).toMatchObject({ code: "wallet_too_new" });
  });

  it("RPC gagal → unavailable (fail-closed di pemanggil)", async () => {
    const checker = new RpcWalletChecker("http://rpc", async () => {
      throw new TypeError("fetch failed");
    });
    expect(await checker.check(WALLET, { minBalanceLamports: 1, minAgeDays: 0 })).toMatchObject({
      status: "unavailable",
    });
  });
});
