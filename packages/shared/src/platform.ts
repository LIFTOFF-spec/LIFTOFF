/**
 * Alamat publik platform LIFTOFF per cluster (hasil Tahap 1, docs/poc-report.md). Hanya pubkey;
 * tidak ada secret di sini.
 */
import type { SolanaCluster } from "./cluster";
import { CURVE_TARGET, type PairConfig } from "./pairs";

export interface PlatformAddresses {
  /** Program Raydium LaunchLab. */
  launchlabProgram: string;
  /** Platform PDA LIFTOFF (platform_config LaunchLab). */
  platformId: string;
  /** Master wallet: creator & payer semua launch (D3). Key-nya hanya dipegang apps/signer. */
  masterWallet: string;
  /** Program Raydium CPMM cluster ini (pool hasil graduation). */
  cpmmProgram: string;
}

/** Otoritas program Raydium per cluster: pemegang vault pool & lock LP. */
export interface RaydiumAuthorities {
  launchlab: string;
  cpmm: string;
  lockCpmm: string;
}

/** Entri tabel per cluster; `masterWallet: null` = pubkey dibaca dari env `MASTER_WALLET_PUBKEY`. */
export interface ClusterPlatform extends Omit<PlatformAddresses, "masterWallet"> {
  masterWallet: string | null;
}

/**
 * Alamat StonkFun mainnet (Tahap 11a), dari respons pricing ASLI
 * (`__fixtures__/stonkfun/pricing-sol-mainnet-2026-10-31.json`, mode `standard`, quote SOL) dan
 * diverifikasi read-only lewat RPC mainnet publik pada 2026-11-01
 * (`scripts/poc/15-mainnet-readonly-verify.ts`, hasil di docs/BUILD_PLAN.md §7l). Hanya pubkey.
 * Allow-config SOL BELUM ADA on-chain (allowlist platform mati, `restrictGlobalConfig=0`);
 * alamatnya tetap disertakan read-only sesuai catatan StonkFun.
 */
export const STONKFUN_MAINNET = {
  launchlabProgram: "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj",
  /** Platform config StonkFun mode `standard` (tanpa transfer fee). */
  platformStandard: "4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7",
  sol: {
    configId: "6s1xP3hpbAfFoNtUNF8mfHsjr2Bd97JxFJRWLbL6aHuX",
    /** PDA `["platform_allow_config", platform, config]`. */
    allowConfigId: "GvAsQKFETH8YwRWxAYLFUy6L83frgHRsnw1FwC1asmJJ",
    /** PDA `["platform_curve_rule", platform, config]`. */
    curveRuleId: "9emka7JGUqvjzXvd95KQTPBEdBU6Ds43f238jXhBvUmN",
  },
} as const;

const BASE58_PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** true bila teks berbentuk pubkey Solana (base58, 32–44 karakter). */
export function isPubkeyLike(value: string): boolean {
  return BASE58_PUBKEY.test(value);
}

/**
 * Program & otoritas Raydium per cluster, salinan `DEVNET_PROGRAM_ID` / `ALL_PROGRAM_ID` SDK
 * Raydium (paket ini tidak memuat SDK; kecocokannya diuji di packages/solana/src/launchlab.test.ts).
 */
const RAYDIUM_DEVNET = {
  cpmmProgram: "DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb",
  authorities: {
    launchlab: "5xqNaZXX5eUi4p5HU4oz9i5QnwRNT2y6oN7yyn4qENeq",
    cpmm: "CXniRufdq5xL8t8jZAPxsPZDpuudwuJSPWnbcD5Y5Nxq",
    lockCpmm: "7qWVV8UY2bRJfDLP4s37YzBPKUkVB46DStYJBpYbQzu3",
  },
} as const;
const RAYDIUM_MAINNET = {
  cpmmProgram: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  authorities: {
    launchlab: "WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh",
    cpmm: "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL",
    lockCpmm: "3f7GcQFG397GAaEnv51zR6tsTVihYRydnydDD1cXekxH",
  },
} as const;

/** Otoritas Raydium cluster ini (bukan holder sungguhan; lock LP). */
export function raydiumAuthoritiesFor(cluster: SolanaCluster): RaydiumAuthorities {
  if (cluster === "testnet") throw new Error("Raydium tidak ter-deploy di testnet");
  return cluster === "mainnet-beta" ? RAYDIUM_MAINNET.authorities : RAYDIUM_DEVNET.authorities;
}

export const PLATFORM_BY_CLUSTER: Record<SolanaCluster, ClusterPlatform | null> = {
  devnet: {
    launchlabProgram: "DRay6fNdQ5J82H7xV6uq2aV3mNrUZ1J4PgSKsWgptcm6",
    platformId: "21vCqsaZhkK8NY1DmPQJuD3bLxjGCeLHbLZrbHpjxozE",
    masterWallet: "4xU25ckRqi5aeRZsAvZotvBCRcyQH3rvdPN3x5pgmCFj",
    cpmmProgram: RAYDIUM_DEVNET.cpmmProgram,
  },
  testnet: null, // LaunchLab tidak ter-deploy di testnet
  // Mainnet: launch lewat platform standard StonkFun (bukan Platform PDA LIFTOFF). Master wallet
  // mainnet = keypair BARU milik pemilik; pubkey-nya diisi lewat env, tidak ditulis di repo.
  "mainnet-beta": {
    launchlabProgram: STONKFUN_MAINNET.launchlabProgram,
    platformId: STONKFUN_MAINNET.platformStandard,
    masterWallet: null,
    cpmmProgram: RAYDIUM_MAINNET.cpmmProgram,
  },
};

type MasterWalletEnv = { readonly [name: string]: string | undefined };

/**
 * Alamat platform untuk cluster. Bila tabel tidak memuat master wallet (mainnet), pubkey dibaca
 * dari `MASTER_WALLET_PUBKEY` (wajib). Ini TIDAK membuka mainnet: kuncinya ada di `resolveCluster`.
 */
export function platformFor(
  cluster: SolanaCluster,
  env: MasterWalletEnv = typeof process === "undefined" ? {} : process.env,
): PlatformAddresses {
  const p = PLATFORM_BY_CLUSTER[cluster];
  if (!p) throw new Error(`platform LIFTOFF belum ada di cluster ${cluster}`);
  if (p.masterWallet) return { ...p, masterWallet: p.masterWallet };
  const master = env.MASTER_WALLET_PUBKEY?.trim() ?? "";
  if (!BASE58_PUBKEY.test(master)) {
    throw new Error(
      `MASTER_WALLET_PUBKEY wajib berisi pubkey master wallet ${cluster} (bukan private key)`,
    );
  }
  return { ...p, masterWallet: master };
}

export interface CurveParams {
  /** Supply mentah (desimal token 6). */
  supply: bigint;
  /** Jumlah token yang dijual di kurva (79,31% supply, default LaunchLab). */
  totalSellA: bigint;
  /** Target dana graduation dalam satuan terkecil quote mint. */
  totalFundRaisingB: bigint;
  tokenDecimals: number;
}

const SUPPLY_RAW = BigInt(CURVE_TARGET.totalSupply) * 10n ** BigInt(CURVE_TARGET.tokenDecimals);
const TOTAL_SELL_BPS = 7_931n; // 79,31%, sama dengan launch PoC

/**
 * Parameter kurva setara USD (P3): target graduation `CURVE_TARGET.graduationUsd` dikonversi ke
 * unit pair memakai harga asumsi pair, tidak pernah di bawah `minFundRaisingB` config Raydium.
 */
export function curveParamsFor(pair: PairConfig): CurveParams {
  // Hitung dalam sen USD agar harga asumsi berdesimal tetap eksak dalam bigint.
  const priceCents = BigInt(Math.round(pair.assumedPriceUsd * 100));
  if (priceCents <= 0n) throw new Error(`harga asumsi pair ${pair.id} tidak valid`);
  const targetCents = BigInt(CURVE_TARGET.graduationUsd) * 100n;
  const raw = (targetCents * 10n ** BigInt(pair.decimals)) / priceCents;
  const min = BigInt(pair.minFundRaisingRaw);
  return {
    supply: SUPPLY_RAW,
    totalSellA: (SUPPLY_RAW * TOTAL_SELL_BPS) / 10_000n,
    totalFundRaisingB: raw < min ? min : raw,
    tokenDecimals: CURVE_TARGET.tokenDecimals,
  };
}

/**
 * Akun tip Jito mainnet (publik, dari dokumentasi Jito; dicek ulang lewat getTipAccounts di
 * Tahap 10). Signer hanya mengizinkan transfer System ke alamat-alamat ini sebagai tip.
 */
export const JITO_TIP_ACCOUNTS: readonly string[] = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];
