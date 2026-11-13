import { describe, expect, it } from "vitest";
import { mainnetUnlockIssues, resolveCluster } from "./index";

const PUBKEY = "HxM1EeyZ9z71m8mu5x9bsUdtTP1f9qtT7mo9D5tB3xwM";
const SEMUA_SYARAT = {
  SOLANA_CLUSTER: "mainnet-beta",
  STONKFUN_MAINNET_ENABLED: "1",
  LIFTOFF_MAINNET_APPROVED: "ya",
  MASTER_WALLET_PUBKEY: PUBKEY,
};
type Syarat = keyof typeof SEMUA_SYARAT;
const NAMA = Object.keys(SEMUA_SYARAT) as Syarat[];

/** Semua kombinasi syarat lain + SOLANA_CLUSTER=mainnet-beta (2^3 = 8). */
function kombinasi(): Array<{ env: Record<string, string>; hilang: Syarat[] }> {
  const lain = NAMA.filter((n) => n !== "SOLANA_CLUSTER");
  return Array.from({ length: 2 ** lain.length }, (_, mask) => {
    const env: Record<string, string> = { SOLANA_CLUSTER: "mainnet-beta" };
    const hilang: Syarat[] = [];
    lain.forEach((n, i) => {
      if (mask & (1 << i)) env[n] = SEMUA_SYARAT[n];
      else hilang.push(n);
    });
    return { env, hilang };
  });
}

describe("resolveCluster", () => {
  it("default ke devnet: mainnet tetap mati tanpa konfigurasi", () => {
    expect(resolveCluster({})).toBe("devnet");
    expect(resolveCluster({ SOLANA_CLUSTER: "" })).toBe("devnet");
  });

  it("menerima devnet dan testnet tanpa syarat mainnet", () => {
    expect(resolveCluster({ SOLANA_CLUSTER: "devnet" })).toBe("devnet");
    expect(resolveCluster({ SOLANA_CLUSTER: "testnet" })).toBe("testnet");
  });

  it("menolak nilai tidak dikenal", () => {
    expect(() => resolveCluster({ SOLANA_CLUSTER: "localnet-x" })).toThrow(/tidak dikenal/);
    expect(() => resolveCluster({ SOLANA_CLUSTER: "mainnet" })).toThrow(/tidak dikenal/);
  });

  it("mainnet-beta hanya diterima bila SEMUA syarat terpenuhi (8 kombinasi)", () => {
    const hasil = kombinasi();
    expect(hasil).toHaveLength(8);
    for (const { env, hilang } of hasil) {
      if (hilang.length === 0) {
        expect(resolveCluster(env)).toBe("mainnet-beta");
        continue;
      }
      let pesan = "";
      try {
        resolveCluster(env);
      } catch (err) {
        pesan = (err as Error).message;
      }
      expect(pesan, `kombinasi hilang: ${hilang.join()}`).toMatch(/mainnet-beta ditolak/);
      for (const n of hilang) expect(pesan).toContain(n);
    }
  });

  it.each([
    ["flag bukan 1", { STONKFUN_MAINNET_ENABLED: "true" }, "STONKFUN_MAINNET_ENABLED"],
    ["flag 0", { STONKFUN_MAINNET_ENABLED: "0" }, "STONKFUN_MAINNET_ENABLED"],
    ["persetujuan bukan ya", { LIFTOFF_MAINNET_APPROVED: "yes" }, "LIFTOFF_MAINNET_APPROVED"],
    ["persetujuan huruf besar", { LIFTOFF_MAINNET_APPROVED: "YA" }, "LIFTOFF_MAINNET_APPROVED"],
    ["pubkey kosong", { MASTER_WALLET_PUBKEY: "  " }, "MASTER_WALLET_PUBKEY"],
    ["pubkey bukan base58", { MASTER_WALLET_PUBKEY: "0OIl" }, "MASTER_WALLET_PUBKEY"],
    ["array private key", { MASTER_WALLET_PUBKEY: "[1,2,3]" }, "MASTER_WALLET_PUBKEY"],
  ])("nilai salah ditolak: %s", (_nama, ubah, syarat) => {
    expect(() => resolveCluster({ ...SEMUA_SYARAT, ...ubah })).toThrow(syarat);
  });

  it("pesan penolakan tidak mengulang isi nilai env", () => {
    expect(() =>
      resolveCluster({ ...SEMUA_SYARAT, MASTER_WALLET_PUBKEY: "[9,9,9,rahasia]" }),
    ).toThrow(expect.objectContaining({ message: expect.not.stringContaining("rahasia") }));
  });

  it("syarat mainnet di cluster devnet tidak mengubah apa pun", () => {
    expect(resolveCluster({ ...SEMUA_SYARAT, SOLANA_CLUSTER: "devnet" })).toBe("devnet");
  });
});

describe("mainnetUnlockIssues", () => {
  it("kosong bila lengkap; menyebut semua syarat bila env kosong", () => {
    expect(mainnetUnlockIssues(SEMUA_SYARAT)).toEqual([]);
    expect(mainnetUnlockIssues({})).toHaveLength(4);
  });
});
