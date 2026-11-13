import { readFileSync } from "node:fs";
import {
  emulatedPricing,
  pairsFor,
  platformFor,
  pricingFromApi,
  pricingResponseSchema,
  raydiumAuthoritiesFor,
  StaticStonkFunAdapter,
} from "@liftoff/shared";
import { ALL_PROGRAM_ID, DEVNET_PROGRAM_ID, LaunchpadConfig } from "@raydium-io/raydium-sdk-v2";
import { Keypair, PublicKey, type Connection, type VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { buildLaunchTransaction, launchAccountPdas } from "./launchlab";
import {
  ASSOCIATED_TOKEN_PROGRAM,
  associatedTokenAddress,
  TOKEN_2022_PROGRAM,
} from "./token-program";

/** Respons ASLI `/launchlab/pricing?quoteMint=SOL` (pemilik, 2026-10-31). */
const real = pricingResponseSchema.parse(
  JSON.parse(
    readFileSync(
      new URL(
        "../../shared/src/__fixtures__/stonkfun/pricing-sol-mainnet-2026-10-31.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
).data;
const SOL = "So11111111111111111111111111111111111111112";
const pairsMainnet = () => pairsFor("mainnet-beta").find((p) => p.id === "sol")!;

describe("alamat Raydium per cluster = konstanta SDK", () => {
  const master = { MASTER_WALLET_PUBKEY: "HxM1EeyZ9z71m8mu5x9bsUdtTP1f9qtT7mo9D5tB3xwM" };

  it.each([
    ["devnet", DEVNET_PROGRAM_ID],
    ["mainnet-beta", ALL_PROGRAM_ID],
  ] as const)("%s", (cluster, sdk) => {
    const p = platformFor(cluster, master);
    expect(p.launchlabProgram).toBe(sdk.LAUNCHPAD_PROGRAM.toBase58());
    expect(p.cpmmProgram).toBe(sdk.CREATE_CPMM_POOL_PROGRAM.toBase58());
    expect(raydiumAuthoritiesFor(cluster)).toEqual({
      launchlab: sdk.LAUNCHPAD_AUTH.toBase58(),
      cpmm: sdk.CREATE_CPMM_POOL_AUTH.toBase58(),
      lockCpmm: sdk.LOCK_CPMM_AUTH.toBase58(),
    });
  });

  it("mainnet tidak memakai satu pun alamat devnet", () => {
    const main = platformFor("mainnet-beta", master);
    const dev = platformFor("devnet");
    expect(main.launchlabProgram).not.toBe(dev.launchlabProgram);
    expect(main.cpmmProgram).not.toBe(dev.cpmmProgram);
    expect(main.platformId).not.toBe(dev.platformId);
    expect(main.masterWallet).not.toBe(dev.masterWallet);
    const a = raydiumAuthoritiesFor("mainnet-beta");
    const b = raydiumAuthoritiesFor("devnet");
    for (const k of ["launchlab", "cpmm", "lockCpmm"] as const) expect(a[k]).not.toBe(b[k]);
  });

  it("launch mainnet menolak base mint SPL klasik", async () => {
    const platform = platformFor("mainnet-beta", master);
    const pair = pairsMainnet();
    const pricing = {
      ...pricingFromApi(real, SOL, { launchAccounts: launchAccountPdas }),
      baseTokenProgram: "spl" as const,
    };
    await expect(
      buildLaunchTransaction({
        connection: {} as Connection,
        platform,
        pair,
        pricing,
        mint: "So11111111111111111111111111111111111111112",
        name: "A",
        symbol: "A",
        uri: "https://x",
      }),
    ).rejects.toThrow(/Token-2022/);
  });
});

describe("launch pair non-SOL", () => {
  const master = { MASTER_WALLET_PUBKEY: "HxM1EeyZ9z71m8mu5x9bsUdtTP1f9qtT7mo9D5tB3xwM" };
  const platform = platformFor("mainnet-beta", master);
  const QUOTE = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
  const CONFIG = "8gj14w8vkNZjJTPak6e96Uf1sY438WKheH4s5dHyxiRw";
  const MINT = Keypair.generate().publicKey.toBase58();
  const ata = associatedTokenAddress(platform.masterWallet, QUOTE, TOKEN_2022_PROGRAM);

  function mintAccount(tlv: Array<[number, Buffer]> = []) {
    const parts: Buffer[] = [Buffer.alloc(166)];
    parts[0]![44] = 8;
    parts[0]![165] = 1;
    for (const [t, body] of tlv) {
      const head = Buffer.alloc(4);
      head.writeUInt16LE(t, 0);
      head.writeUInt16LE(body.length, 2);
      parts.push(head, body);
    }
    return Buffer.concat(parts);
  }

  function fakeConnection(opts: { quote: Buffer; ataExists?: boolean }) {
    const cfg = Buffer.alloc(LaunchpadConfig.span);
    new PublicKey(QUOTE).toBuffer().copy(cfg, LaunchpadConfig.offsetOf("mintB"));
    const accounts: Record<string, { owner: PublicKey; data: Buffer } | null> = {
      [CONFIG]: { owner: new PublicKey(platform.launchlabProgram), data: cfg },
      [QUOTE]: { owner: new PublicKey(TOKEN_2022_PROGRAM), data: opts.quote },
      [ata]: opts.ataExists
        ? { owner: new PublicKey(TOKEN_2022_PROGRAM), data: Buffer.alloc(179) }
        : null,
    };
    return {
      getAccountInfo: async (k: PublicKey) => accounts[k.toBase58()] ?? null,
      getLatestBlockhash: async () => ({
        blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k",
        lastValidBlockHeight: 1,
      }),
    } as unknown as Connection;
  }

  const build = (connection: Connection) => {
    const pdas = launchAccountPdas(platform.launchlabProgram, platform.platformId, CONFIG);
    return buildLaunchTransaction({
      connection,
      platform,
      pair: { ...pairsMainnet(), mint: QUOTE, configId: CONFIG, decimals: 8 },
      pricing: {
        ...pricingFromApi(real, SOL, { launchAccounts: launchAccountPdas }),
        quoteMint: QUOTE,
        configId: CONFIG,
        allowConfigId: pdas.allowConfigId,
        curveRuleId: pdas.curveRuleId,
      },
      mint: MINT,
      name: "Twenty Characters Xx",
      symbol: "ABCDEFGHIJ",
      uri: "https://liftoff.sarl/api/tokens/00000000-0000-0000-0000-000000000000/metadata.json",
      tip: { account: "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5", lamports: 1_000_000 },
    });
  };
  const programs = (tx: { message: VersionedTransaction["message"] }) =>
    tx.message.compiledInstructions.map((i) =>
      tx.message.staticAccountKeys[i.programIdIndex]!.toBase58(),
    );

  it("ATA quote master dibuat bila belum ada, dan transaksi tetap muat batas ukuran", async () => {
    const { transaction } = await build(fakeConnection({ quote: mintAccount() }));
    expect(programs(transaction)).toContain(ASSOCIATED_TOKEN_PROGRAM);
    expect(transaction.message.staticAccountKeys.map((k) => k.toBase58())).toContain(ata);
    expect(transaction.serialize().length).toBeLessThanOrEqual(1232);
  });

  it("ATA sudah ada: tidak dibuat lagi", async () => {
    const { transaction } = await build(fakeConnection({ quote: mintAccount(), ataExists: true }));
    expect(programs(transaction)).not.toContain(ASSOCIATED_TOKEN_PROGRAM);
  });

  it("hook yang dimatikan boleh; hook aktif, transfer fee, dan desimal beda ditolak saat build", async () => {
    await expect(
      build(fakeConnection({ quote: mintAccount([[14, Buffer.alloc(64)]]) })),
    ).resolves.toBeDefined();
    const hook = Buffer.alloc(64);
    hook.fill(9, 32);
    await expect(build(fakeConnection({ quote: mintAccount([[14, hook]]) }))).rejects.toThrow(
      /hook/,
    );
    const fee = Buffer.alloc(108);
    fee.writeUInt16LE(100, 106);
    await expect(build(fakeConnection({ quote: mintAccount([[1, fee]]) }))).rejects.toThrow(
      /transfer fee/,
    );
    const six = mintAccount();
    six[44] = 6;
    await expect(build(fakeConnection({ quote: six }))).rejects.toThrow(/desimal/);
  });
});

describe("PDA allow-config & curve-rule", () => {
  it("turunan lokal = alamat StonkFun asli untuk ketiga mode (platform × config mainnet)", () => {
    for (const mode of ["standard", "reward", "community"] as const) {
      const pdas = launchAccountPdas(
        real.curve.programId,
        real.platform[mode]!,
        real.curve.configId,
      );
      expect(pdas.allowConfigId).toBe(real.allowConfig![mode]);
      expect(pdas.curveRuleId).toBe((real.curveRule as Record<string, string>)[mode]);
    }
  });

  it("pricingFromApi dengan turunan lokal → alamat cocok; respons dengan alamat lain ditolak", () => {
    const pricing = pricingFromApi(real, SOL, { launchAccounts: launchAccountPdas });
    expect(pricing.allowConfigId).toBe("GvAsQKFETH8YwRWxAYLFUy6L83frgHRsnw1FwC1asmJJ");
    expect(pricing.curveRuleId).toBe("9emka7JGUqvjzXvd95KQTPBEdBU6Ds43f238jXhBvUmN");
    // Alamat reward dipakai untuk mode standard → bukan PDA platform standard.
    const swapped = {
      ...real,
      allowConfig: { ...real.allowConfig!, standard: real.allowConfig!.reward },
    };
    expect(() => pricingFromApi(swapped, SOL, { launchAccounts: launchAccountPdas })).toThrow(
      /allow-config/,
    );
  });
});

describe("buildLaunchTransaction — pagar allow-config (sebelum RPC apa pun)", () => {
  const platform = platformFor("devnet");
  const noRpc = new Proxy({} as Connection, {
    get: () => () => {
      throw new Error("RPC tidak boleh dipanggil");
    },
  });
  const setup = async () => {
    const s = new StaticStonkFunAdapter();
    const pair = (await s.listPairs()).pairs.find((p) => p.id === "sol")!;
    const config = await s.activeLaunchConfig();
    const pdas = launchAccountPdas(platform.launchlabProgram, platform.platformId, pair.configId);
    return { pair, config, pdas };
  };
  const build = (pair: Awaited<ReturnType<typeof setup>>["pair"], pricing: object) =>
    buildLaunchTransaction({
      connection: noRpc,
      platform,
      mint: platformFor("devnet").masterWallet,
      name: "T",
      symbol: "T",
      uri: "https://example.invalid/m.json",
      pair,
      pricing: pricing as never,
    });

  it("allow-config bukan PDA platform/config, available=false, atau wajib tapi kosong → ditolak", async () => {
    const { pair, config, pdas } = await setup();
    const ok = emulatedPricing(config, pair, {
      curveRuleId: null,
      allowConfigId: pdas.allowConfigId,
    });
    await expect(build(pair, { ...ok, allowConfigId: SOL })).rejects.toThrow(
      /allow-config bukan PDA/,
    );
    await expect(build(pair, { ...ok, curveRuleId: SOL })).rejects.toThrow(/curve-rule bukan PDA/);
    await expect(build(pair, { ...ok, allowConfigAvailable: false })).rejects.toThrow(/menolak/);
    await expect(build(pair, { ...ok, allowConfigId: null })).rejects.toThrow(/wajib/);
    // Pricing sah lolos pagar dan baru berhenti di RPC (proxy).
    await expect(build(pair, ok)).rejects.toThrow(/RPC tidak boleh/);
  });
});
