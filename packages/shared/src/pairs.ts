/**
 * REGISTRI LABEL pair (quote mint) — BUKAN daftar pair yang tersedia.
 *
 * Spec §6: daftar pair wajib dimuat dinamis dari StonkFun. Ketersediaan (launchable &
 * LaunchLab-ready) selalu datang dari `StonkFunAdapter.listPairs()`, yang di devnet memindai
 * global config LaunchLab on-chain (packages/solana/src/stonkfun.ts). Registri ini hanya memberi
 * label, ID stabil, dan harga USD asumsi (untuk kurva setara USD, P3) bagi config yang dikenal,
 * serta dipakai untuk menampilkan simbol token lama. Config yang ditemukan on-chain tetapi tidak
 * ada di sini tetap tampil, namun tidak launchable (tidak ada harga acuan).
 *
 * Hasil Tahap 1 (docs/poc-report.md, bagian c): launch on-chain terbukti di kelima config devnet.
 */ import type { SolanaCluster } from "./cluster";
import { rememberQuoteRaise } from "./economic-config";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export interface PairConfig {
  /** ID stabil yang dipakai API & form launch. */
  id: string;
  symbol: string;
  name: string;
  /** Global config LaunchLab untuk quote mint ini. */
  configId: string;
  configIndex: number;
  mint: string;
  decimals: number;
  /** Launch on-chain terbukti berhasil di Tahap 1. */
  supported: boolean;
  /** `maxShareFeeRate` config > 0 → LIFTOFF bisa menjadi referrer (FEE_CONFIG.referralFeeBps). */
  referralSupported: boolean;
  /** `minFundRaisingB` config, dalam satuan terkecil quote. */
  minFundRaisingRaw: string;
  /**
   * Harga USD asumsi untuk menyetarakan kurva antar pair (sama dengan asumsi PoC).
   * BUKAN harga pasar. 0 = tidak ada asumsi (mainnet: USD hanya dari harga nyata, lihat sol-price.ts).
   */
  assumedPriceUsd: number;
  note: string | null;
}

/**
 * Target kurva setara USD untuk semua pair (P3), sama dengan launch PoC Tahap 1:
 * graduation $12.000 dan harga awal ≈ $0,00000395/token (supply 1 miliar) → market cap awal ≈ $3.947.
 * Status `estimated`: bergantung pada harga asumsi pair.
 */
export const CURVE_TARGET = {
  status: "estimated" as const,
  totalSupply: "1000000000",
  /** Desimal token LaunchLab (supply mentah 1e15). */
  tokenDecimals: 6,
  startMarketCapUsd: 3_947,
  graduationUsd: 12_000,
};

const DEVNET_PAIRS: PairConfig[] = [
  {
    id: "sol",
    symbol: "SOL",
    name: "Solana (config 0)",
    configId: "7ZR4zD7PYfY2XxoG1Gxcy2EgEeGYrpxrwzPuwdUBssEt",
    configIndex: 0,
    mint: "So11111111111111111111111111111111111111112",
    decimals: 9,
    supported: true,
    referralSupported: true,
    minFundRaisingRaw: "1",
    assumedPriceUsd: 150,
    note: null,
  },
  {
    id: "sol-1",
    symbol: "SOL",
    name: "Solana (config 1)",
    configId: "DQe2B8w3RYKsUkWBRipt1iNCuy6YwmN6krgdQspQBfrd",
    configIndex: 1,
    mint: "So11111111111111111111111111111111111111112",
    decimals: 9,
    supported: true,
    referralSupported: true,
    minFundRaisingRaw: "30000000000",
    assumedPriceUsd: 150,
    note: "Minimum raise 30 SOL per config.",
  },
  {
    id: "usdc",
    symbol: "USDC",
    name: "USD Coin (devnet)",
    configId: "4wHbNkobu7iARU9MbCEqDSAq6JuQreGupG2Jsf2R3DFP",
    configIndex: 0,
    mint: "USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT",
    decimals: 6,
    supported: true,
    referralSupported: true,
    minFundRaisingRaw: "1",
    assumedPriceUsd: 1,
    note: null,
  },
  {
    id: "ray",
    symbol: "RAY",
    name: "Raydium (devnet)",
    configId: "2t3jEnQ1KGndXbNmyLsEuhYip7XjF7V1p1fhsTYVkhpw",
    configIndex: 0,
    mint: "DRay3aNHKdjZ4P4DoRnyxdKh6jBrf4HpjfDkQF7MFPpR",
    decimals: 6,
    supported: true,
    referralSupported: false,
    minFundRaisingRaw: "1",
    assumedPriceUsd: 2,
    note: "Config has maxShareFeeRate 0: no referral fee on this pair.",
  },
  {
    id: "devnet-8du8",
    symbol: "8DU8",
    name: "Unlabelled devnet mint 8Du8…beAB",
    configId: "6EiPNvGkwbtDon4HMxzaXFHmko6mYXwMZEjpHzup8rD6",
    configIndex: 0,
    mint: "8Du8VJoE6rVghNxJLa9dcR7m8JwQu9ByKxGJkDD5beAB",
    decimals: 9,
    supported: true,
    referralSupported: true,
    minFundRaisingRaw: "1",
    assumedPriceUsd: 1,
    note: "Devnet-only test mint with no known market.",
  },
];

/**
 * Label mainnet (Tahap 11a). Ketersediaan & target raise tetap dari StonkFun (`/pairs`,
 * `/launchlab/pricing`). Nilai config dibaca on-chain 2026-11-01 (scripts/poc/15): index 0,
 * `maxShareFeeRate` 10000 (> 0), `minFundRaisingB` 24 SOL (= `raise.minimumRaw` pricing asli).
 * Tanpa harga asumsi (0): dengan uang asli, angka USD dari harga tetap sama dengan angka palsu.
 */
const MAINNET_PAIRS: PairConfig[] = [
  {
    id: "sol",
    symbol: "SOL",
    name: "Solana",
    configId: "6s1xP3hpbAfFoNtUNF8mfHsjr2Bd97JxFJRWLbL6aHuX",
    configIndex: 0,
    mint: "So11111111111111111111111111111111111111112",
    decimals: 9,
    supported: true,
    referralSupported: true,
    minFundRaisingRaw: "24000000000",
    assumedPriceUsd: 0,
    note: null,
  },
];

export const PAIRS_BY_CLUSTER: Record<SolanaCluster, PairConfig[]> = {
  devnet: DEVNET_PAIRS,
  testnet: [], // LaunchLab tidak ter-deploy di testnet (Tahap 1)
  "mainnet-beta": MAINNET_PAIRS,
};

/**
 * Aset yang disebut Spec §6 selain SOL/USDC. Hanya tampil jika StonkFun (devnet: global config
 * on-chain) menyediakan config-nya; jika tidak, dilaporkan sebagai tidak tersedia.
 */
export const SPEC_WATCHLIST_ASSETS = ["SPYx", "NVDAx", "TSLAx", "QQQx"] as const;

/**
 * Tombol pembukaan pair non-SOL (keputusan pemilik 2026-11-02, BUILD_PLAN §8 & §7q): kode untuk semua
 * pair StonkFun siap, tetapi launch baru non-SOL di mainnet tetap tertutup sampai `PAIRS_NON_SOL_ENABLED=1`.
 * Dinyalakan setelah satu launch uji non-SOL dan penerusan fee-nya terbukti. Trade token yang sudah
 * ada tidak terpengaruh. Cluster lain tidak dibatasi.
 */
export interface PairAccess {
  nonSolEnabled: boolean;
}

export function pairAccessFrom(env: NodeJS.ProcessEnv = process.env): PairAccess {
  return { nonSolEnabled: env.PAIRS_NON_SOL_ENABLED?.trim() === "1" };
}

export const NON_SOL_CLOSED_MESSAGE =
  "Not open yet on LIFTOFF: this pair is listed by StonkFun, but non-SOL launches stay closed until creator-fee forwarding is proven in a live test.";

/** Kategori `custom` StonkFun dibuka dengan label ini (keputusan pemilik 2026-11-02). */
export const CUSTOM_PAIR_WARNING =
  "Community-listed token. Anyone can list one and symbols can repeat, so check the mint address. Its price can fall to zero, and the fees and reserve of your coin are held in this token.";

/** Label registri untuk sebuah cluster (lihat catatan di atas: bukan sumber ketersediaan). */
export function pairsFor(cluster: SolanaCluster): PairConfig[] {
  return PAIRS_BY_CLUSTER[cluster];
}

/**
 * Katalog quote yang sudah pernah dipakai launch (tabel `quote_assets`, diisi worker sesudah pair
 * diverifikasi on-chain). Registri hanya memuat SOL di mainnet, jadi simbol & desimal pair lain
 * datang dari sini. Dimuat ke memori oleh `refreshQuoteAssets` (@liftoff/db) karena pemakainya sinkron.
 */
export interface QuoteAsset {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  /** Target raise launch terakhir (mentah). Dasar skala batas per quote, lihat `perQuote`. */
  raiseRaw: string | null;
}

const quoteBooks = new Map<SolanaCluster, Map<string, PairConfig>>();

export function rememberQuoteAssets(cluster: SolanaCluster, assets: readonly QuoteAsset[]) {
  const book = quoteBooks.get(cluster) ?? new Map<string, PairConfig>();
  for (const a of assets) {
    book.set(a.mint, {
      id: `sf-${a.mint}`,
      symbol: a.symbol,
      name: a.name,
      configId: "",
      configIndex: 0,
      mint: a.mint,
      decimals: a.decimals,
      supported: true,
      referralSupported: false,
      minFundRaisingRaw: "0",
      assumedPriceUsd: 0,
      note: null,
    });
    if (a.raiseRaw) rememberQuoteRaise(a.mint, a.raiseRaw);
  }
  quoteBooks.set(cluster, book);
}

/** Pair default untuk quote mint: registri (config indeks terkecil), lalu katalog quote. */
export function pairForMint(cluster: SolanaCluster, mint: string): PairConfig | undefined {
  return pairsFor(cluster).find((p) => p.mint === mint) ?? quoteBooks.get(cluster)?.get(mint);
}

/**
 * Pair sebuah token. `quoteConfigId` token selalu menang: nilai itulah yang dipakai saat launch.
 * undefined = quote belum dikenal; pemanggil wajib gagal tertutup, bukan menebak 9 desimal.
 */
export function pairForToken(
  cluster: SolanaCluster,
  token: { quoteMint: string; quoteConfigId: string },
): PairConfig | undefined {
  const exact = pairsFor(cluster).find((p) => p.configId === token.quoteConfigId);
  if (exact) return exact;
  const byMint = pairForMint(cluster, token.quoteMint);
  return byMint && { ...byMint, configId: token.quoteConfigId };
}
