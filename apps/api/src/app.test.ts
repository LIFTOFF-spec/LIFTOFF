import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import { makeApp, resetDb } from "./test-helpers";

type Ctx = Awaited<ReturnType<typeof makeApp>>;
let ctx: Ctx;

beforeAll(async () => {
  ctx = await makeApp();
}, 120_000);
afterAll(() => ctx.app.close());
beforeEach(() => resetDb(ctx.db));

describe("GET /api/health", () => {
  it("ok saat DB, KV, dan RPC sehat; signer belum dikonfigurasi (Tahap 4)", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "ok",
      service: "api",
      cluster: "devnet",
      checks: { db: "ok", redis: "ok", rpc: "ok", signer: "not_configured" },
    });
  });

  it("degraded saat RPC tidak bisa dihubungi", async () => {
    const { app } = await makeApp({
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: "degraded", checks: { rpc: "down" } });
    await app.close();
  });

  it("mainnet-beta ditolak tanpa semua syarat, diterima bila lengkap", () => {
    const env = {
      SOLANA_CLUSTER: "mainnet-beta",
      STONKFUN_MAINNET_ENABLED: "1",
      LIFTOFF_MAINNET_APPROVED: "ya",
      MASTER_WALLET_PUBKEY: "HxM1EeyZ9z71m8mu5x9bsUdtTP1f9qtT7mo9D5tB3xwM",
      RPC_URL: "https://mainnet.example",
    } as NodeJS.ProcessEnv;
    expect(() => loadConfig({ SOLANA_CLUSTER: "mainnet-beta" } as NodeJS.ProcessEnv)).toThrow(
      /mainnet-beta ditolak/,
    );
    for (const k of [
      "STONKFUN_MAINNET_ENABLED",
      "LIFTOFF_MAINNET_APPROVED",
      "MASTER_WALLET_PUBKEY",
    ]) {
      expect(() => loadConfig({ ...env, [k]: "" })).toThrow(k);
    }
    expect(loadConfig(env).cluster).toBe("mainnet-beta");
  });

  it("mainnet tanpa RPC_URL gagal, tidak jatuh ke RPC devnet", () => {
    expect(() =>
      loadConfig({
        SOLANA_CLUSTER: "mainnet-beta",
        STONKFUN_MAINNET_ENABLED: "1",
        LIFTOFF_MAINNET_APPROVED: "ya",
        MASTER_WALLET_PUBKEY: "HxM1EeyZ9z71m8mu5x9bsUdtTP1f9qtT7mo9D5tB3xwM",
      } as NodeJS.ProcessEnv),
    ).toThrow(/RPC_URL wajib/);
  });
});

describe("GET /api/pairs", () => {
  it("mengembalikan lima global config devnet hasil Tahap 1", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/pairs" });
    const pairs = res.json().data.pairs as Array<{
      id: string;
      configId: string;
      supported: boolean;
    }>;
    expect(pairs.map((p) => p.id)).toEqual(["sol", "sol-1", "usdc", "ray", "devnet-8du8"]);
    expect(pairs.map((p) => p.configId)).toEqual([
      "7ZR4zD7PYfY2XxoG1Gxcy2EgEeGYrpxrwzPuwdUBssEt",
      "DQe2B8w3RYKsUkWBRipt1iNCuy6YwmN6krgdQspQBfrd",
      "4wHbNkobu7iARU9MbCEqDSAq6JuQreGupG2Jsf2R3DFP",
      "2t3jEnQ1KGndXbNmyLsEuhYip7XjF7V1p1fhsTYVkhpw",
      "6EiPNvGkwbtDon4HMxzaXFHmko6mYXwMZEjpHzup8rD6",
    ]);
    expect(pairs.every((p) => p.supported)).toBe(true);
  });
});

describe("errors", () => {
  it("404 JSON untuk route tak dikenal", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });
});
