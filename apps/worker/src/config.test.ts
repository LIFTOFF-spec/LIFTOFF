import { describe, expect, it } from "vitest";
import {
  feeIntakeFrom,
  feeSpendingFrom,
  loadEconomicConfig,
  loadIndexerConfig,
  loadMonitorConfig,
  loadWorkerConfig,
} from "./config";

const base = { SIGNER_AUTH_TOKEN: "x".repeat(32) } as NodeJS.ProcessEnv;

describe("kunci mainnet di semua proses worker", () => {
  const mainnet = {
    ...base,
    SOLANA_CLUSTER: "mainnet-beta",
    STONKFUN_MAINNET_ENABLED: "1",
    LIFTOFF_MAINNET_APPROVED: "ya",
    MASTER_WALLET_PUBKEY: "HxM1EeyZ9z71m8mu5x9bsUdtTP1f9qtT7mo9D5tB3xwM",
    RPC_URL: "https://mainnet.example",
  } as NodeJS.ProcessEnv;
  const loaders = [
    ["launch", loadWorkerConfig],
    ["indexer", loadIndexerConfig],
    ["economic", loadEconomicConfig],
    ["monitor", loadMonitorConfig],
  ] as const;

  it.each(loaders)("%s: lengkap diterima, kurang satu ditolak, tanpa RPC ditolak", (_n, load) => {
    const cfg = load(mainnet);
    expect(cfg.cluster).toBe("mainnet-beta");
    expect(cfg.rpcUrl).toBe("https://mainnet.example");
    expect(cfg.platform.masterWallet).toBe(mainnet.MASTER_WALLET_PUBKEY);
    expect(cfg.platform.cpmmProgram).toBe("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
    for (const k of [
      "STONKFUN_MAINNET_ENABLED",
      "LIFTOFF_MAINNET_APPROVED",
      "MASTER_WALLET_PUBKEY",
    ]) {
      expect(() => load({ ...mainnet, [k]: "" })).toThrow(k);
    }
    expect(() => load({ ...mainnet, RPC_URL: "" })).toThrow(/RPC_URL wajib/);
  });

  it("default tanpa env: devnet", () => {
    for (const [, load] of loaders) expect(load(base).cluster).toBe("devnet");
  });

  it("cabang devnet mati di mainnet", () => {
    expect(() => loadWorkerConfig({ ...mainnet, LAUNCH_DEVNET_FUND_RAISING_RAW: "1" })).toThrow(
      /hanya boleh di devnet/,
    );
    expect(feeIntakeFrom(undefined, "mainnet-beta")).toBe("forwarded");
  });

  it("pembelanjaan fee mati secara default di mainnet, hanya hidup bila diminta tegas", () => {
    expect(loadEconomicConfig(mainnet).economic.feeSpendingEnabled).toBe(false);
    expect(loadEconomicConfig(base).economic.feeSpendingEnabled).toBe(true);
    expect(
      loadEconomicConfig({ ...mainnet, FEE_SPENDING_ENABLED: "1" }).economic.feeSpendingEnabled,
    ).toBe(true);
    expect(() => feeSpendingFrom("ya", "forwarded")).toThrow(/harus 0 atau 1/);
  });

  it("rute graduated default cpmm di semua cluster (jalur jupiter belum dibuat)", () => {
    expect(loadEconomicConfig(mainnet).economic.graduatedRoute).toBe("cpmm");
    expect(loadEconomicConfig(base).economic.graduatedRoute).toBe("cpmm");
  });
});

describe("loadWorkerConfig — target graduation uji devnet", () => {
  it("default null (target normal dari CURVE_TARGET)", () => {
    expect(loadWorkerConfig(base).devnetFundRaisingOverride).toBeNull();
  });

  it("diterima di devnet sebagai bigint", () => {
    const cfg = loadWorkerConfig({ ...base, LAUNCH_DEVNET_FUND_RAISING_RAW: "100000000" });
    expect(cfg.devnetFundRaisingOverride).toBe(100_000_000n);
  });

  it("ditolak di luar devnet dan untuk nilai tidak valid", () => {
    expect(() =>
      loadWorkerConfig({ ...base, SOLANA_CLUSTER: "testnet", LAUNCH_DEVNET_FUND_RAISING_RAW: "1" }),
    ).toThrow(/hanya boleh di devnet/);
    expect(() => loadWorkerConfig({ ...base, LAUNCH_DEVNET_FUND_RAISING_RAW: "0.5" })).toThrow(
      /bilangan bulat/,
    );
  });
});

describe("token signer per worker (F12) & RPC cadangan (F8)", () => {
  const launch = "L".repeat(32);
  const economic = "E".repeat(32);

  it("worker launch memakai SIGNER_LAUNCH_TOKEN, economic memakai SIGNER_ECONOMIC_TOKEN", () => {
    const env = { SIGNER_LAUNCH_TOKEN: launch, SIGNER_ECONOMIC_TOKEN: economic };
    expect(loadWorkerConfig(env).signerAuthToken).toBe(launch);
    expect(loadEconomicConfig(env).signerAuthToken).toBe(economic);
  });

  it("kompatibilitas: tanpa token khusus → SIGNER_AUTH_TOKEN lama", () => {
    expect(loadWorkerConfig(base).signerAuthToken).toBe(base.SIGNER_AUTH_TOKEN);
    expect(loadEconomicConfig(base).signerAuthToken).toBe(base.SIGNER_AUTH_TOKEN);
  });

  it("tanpa token sama sekali / token pendek → gagal start", () => {
    expect(() => loadEconomicConfig({ SIGNER_LAUNCH_TOKEN: launch })).toThrow(
      /SIGNER_ECONOMIC_TOKEN/,
    );
    expect(() => loadWorkerConfig({ SIGNER_LAUNCH_TOKEN: "short" })).toThrow(/minimal 32/);
  });

  it("RPC_BACKUP_URL diteruskan ke config", () => {
    expect(loadWorkerConfig(base).rpcBackupUrl).toBeNull();
    expect(
      loadEconomicConfig({ ...base, RPC_BACKUP_URL: "https://b.devnet.invalid" }).rpcBackupUrl,
    ).toBe("https://b.devnet.invalid");
  });
});
