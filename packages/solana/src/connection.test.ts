import { GENESIS_HASH } from "@liftoff/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertRpcCluster,
  checkRpcCluster,
  createConnection,
  failoverFetch,
  rpcUrlFor,
  RpcUnavailableError,
} from "./connection";

const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("RPC cadangan (F8)", () => {
  it("utama sehat → cadangan tidak dipanggil", async () => {
    const calls: string[] = [];
    const f = failoverFetch(
      async (u) => (calls.push(`p:${String(u)}`), ok({ r: 1 })),
      async (u) => (calls.push(`b:${String(u)}`), ok({ r: 2 })),
      "https://backup.invalid",
    );
    expect(await (await f("https://primary.invalid", {})).json()).toEqual({ r: 1 });
    expect(calls).toEqual(["p:https://primary.invalid"]);
  });

  it("utama timeout / 5xx / 429 → request yang sama dikirim ke cadangan", async () => {
    for (const fail of [
      async () => {
        throw new RpcUnavailableError("timeout");
      },
      async () => ok({}, 503),
      async () => ok({}, 429),
    ]) {
      const seen: Array<{ url: string; body: unknown }> = [];
      const f = failoverFetch(
        fail,
        async (u, init) => {
          seen.push({ url: String(u), body: init?.body });
          return ok({ r: "backup" });
        },
        "https://backup.invalid",
      );
      const res = await f("https://primary.invalid", { method: "POST", body: '{"id":1}' });
      expect(await res.json()).toEqual({ r: "backup" });
      expect(seen).toEqual([{ url: "https://backup.invalid", body: '{"id":1}' }]);
    }
  });

  it("error bukan jaringan (bug) tidak disembunyikan failover", async () => {
    const f = failoverFetch(
      async () => {
        throw new TypeError("bug");
      },
      async () => ok({}),
      "https://backup.invalid",
    );
    await expect(f("https://primary.invalid", {})).rejects.toThrow("bug");
  });

  it("RPC cadangan mainnet ditolak (devnet only)", () => {
    expect(() =>
      createConnection("https://api.devnet.solana.com", {
        backupUrl: "https://api.mainnet-beta.solana.com",
      }),
    ).toThrow(/mainnet/);
  });
});

describe("RPC mengikuti cluster", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** fetch palsu JSON-RPC: tiap URL menjawab genesis tertentu; null = gangguan jaringan. */
  function fakeRpc(genesis: Record<string, string | null>) {
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const g = genesis[new URL(url).host];
      if (g === null || g === undefined) throw new TypeError("network");
      const { id } = JSON.parse(String(init.body)) as { id: string };
      return ok({ jsonrpc: "2.0", id, result: g });
    });
  }
  const MAIN = GENESIS_HASH["mainnet-beta"];
  const DEV = GENESIS_HASH.devnet;

  it("tanpa cluster atau di devnet, URL mainnet tetap ditolak", () => {
    expect(() => createConnection("https://mainnet.helius-rpc.com/?api-key=x")).toThrow(/mainnet/);
    expect(() =>
      createConnection("https://api.mainnet-beta.solana.com", { cluster: "devnet" }),
    ).toThrow(/mainnet/);
  });

  it("di mainnet: URL mainnet diterima, URL devnet ditolak (utama & cadangan)", () => {
    const cluster = "mainnet-beta" as const;
    expect(createConnection("https://mainnet.helius-rpc.com", { cluster })).toBeTruthy();
    expect(() => createConnection("https://api.devnet.solana.com", { cluster })).toThrow(/devnet/);
    expect(() =>
      createConnection("https://rpc.example.com", {
        cluster,
        backupUrl: "https://devnet.helius-rpc.com",
      }),
    ).toThrow(/devnet/);
  });

  it("rpcUrlFor: hanya devnet yang punya default", () => {
    expect(rpcUrlFor("devnet")).toContain("devnet");
    expect(rpcUrlFor("devnet", " ", "https://a.example")).toBe("https://a.example");
    expect(rpcUrlFor("mainnet-beta", "", "https://a.example")).toBe("https://a.example");
    expect(() => rpcUrlFor("mainnet-beta", undefined, "")).toThrow(/RPC_URL wajib/);
    expect(() => rpcUrlFor("testnet")).toThrow(/RPC_URL wajib/);
  });

  it("checkRpcCluster membedakan cocok, salah cluster, dan tidak terjangkau", async () => {
    fakeRpc({ "a.example": MAIN, "b.example": DEV, "c.example": null });
    expect(await checkRpcCluster("https://a.example", "mainnet-beta")).toEqual({
      ok: true,
      genesis: MAIN,
    });
    expect(await checkRpcCluster("https://b.example", "mainnet-beta")).toMatchObject({
      ok: false,
      reason: "wrong_cluster",
    });
    expect(await checkRpcCluster("https://c.example", "mainnet-beta")).toMatchObject({
      ok: false,
      reason: "unreachable",
    });
  });

  it("start mainnet: utama wajib genesis mainnet; cadangan salah cluster ditolak", async () => {
    fakeRpc({ "m.example": MAIN, "d.example": DEV, "x.example": null });
    await expect(
      assertRpcCluster("mainnet-beta", "https://m.example", "https://m.example"),
    ).resolves.toBeUndefined();
    await expect(assertRpcCluster("mainnet-beta", "https://d.example")).rejects.toThrow(
      /RPC_URL bukan RPC mainnet-beta/,
    );
    await expect(
      assertRpcCluster("mainnet-beta", "https://m.example", "https://d.example"),
    ).rejects.toThrow(/RPC_BACKUP_URL bukan RPC mainnet-beta/);
    await expect(assertRpcCluster("mainnet-beta", "https://x.example")).rejects.toThrow(
      /tidak menjawab/,
    );
    // Cadangan yang sedang gangguan tidak menghentikan layanan.
    await expect(
      assertRpcCluster("mainnet-beta", "https://m.example", "https://x.example"),
    ).resolves.toBeUndefined();
  });

  it("start devnet: RPC yang ternyata mainnet ditolak; gangguan & validator lokal tidak", async () => {
    fakeRpc({
      "m.example": MAIN,
      "d.example": DEV,
      "l.example": "LocalGenesis",
      "x.example": null,
    });
    await expect(assertRpcCluster("devnet", "https://m.example")).rejects.toThrow(/mainnet/);
    await expect(assertRpcCluster("devnet", "https://d.example")).resolves.toBeUndefined();
    await expect(assertRpcCluster("devnet", "https://l.example")).resolves.toBeUndefined();
    await expect(assertRpcCluster("devnet", "https://x.example")).resolves.toBeUndefined();
  });

  it("pesan error tidak memuat URL RPC (bisa berisi API key)", async () => {
    fakeRpc({ "d.example": DEV });
    await expect(
      assertRpcCluster("mainnet-beta", "https://d.example/?api-key=RAHASIA"),
    ).rejects.toThrow(expect.objectContaining({ message: expect.not.stringContaining("RAHASIA") }));
  });
});
