/**
 * Lapisan adapter StonkFun (Spec §3–6, §14, §19 "StonkFun Developer API").
 *
 * Spec membangun LIFTOFF di atas StonkFun: launch lewat Raydium LaunchLab memakai config
 * StonkFun, StonkFun "mengadopsi" token, daftar pair datang dari supported-pairs endpoint
 * StonkFun, dan creator fee diteruskan ke penerima yang ditunjuk. StonkFun hanya ada di mainnet
 * (keputusan pemilik, docs/BUILD_PLAN.md D-S1 + "StonkFun Developer API"):
 *
 *  - Devnet: `DevnetStonkFunAdapter` (packages/solana/src/stonkfun.ts) mengemulasikan StonkFun.
 *    Platform PDA LIFTOFF berperan sebagai "platform StonkFun tiruan"; config dan pair dibaca
 *    ON-CHAIN (Platform PDA + global config Raydium), bukan list statis. Fee masuk lewat claim.
 *  - Mainnet: `MainnetStonkFunAdapter` (stonkfun-api.ts) = klien Developer API StonkFun
 *    (`/pairs`, `/launchlab/pricing`, `/tokens/{mint}`, `/launches`, `/tokens/{mint}/fees`).
 *    TERKUNCI: hanya aktif bila cluster mainnet-beta DAN flag eksplisit (Tahap 10). Creator fee
 *    LaunchLab standar diteruskan otomatis ke wallet creator (strategi `forwarded`).
 *
 * Semua kode launch WAJIB lewat interface ini, sehingga mengganti emulasi dengan StonkFun asli
 * hanya mengganti implementasi. Launch gagal aman bila pair/config tidak tersedia atau berubah
 * sejak divalidasi (`launchFingerprint`, Spec §4).
 */
import type { SolanaCluster } from "./cluster";
import { pairsFor, WSOL_MINT, type PairConfig } from "./pairs";
import { curveParamsFor, platformFor } from "./platform";
import type { PriceObservation } from "./sol-price";

export type StonkFunSource = "devnet_emulation" | "stonkfun_mainnet";

/** Config LaunchLab aktif dari StonkFun (devnet: Platform PDA LIFTOFF). */
export interface StonkFunLaunchConfig {
  source: StonkFunSource;
  launchlabProgram: string;
  /** Platform config yang dipakai semua launch (devnet: Platform PDA LIFTOFF = StonkFun tiruan). */
  platformId: string;
  /** Platform fee curve, rate per 1_000_000 (milik StonkFun, bukan LIFTOFF). */
  platformFeeRate: number;
  /** Creator fee curve, rate per 1_000_000 → creator (master wallet LIFTOFF). */
  creatorFeeRate: number;
  /** Config CPMM tujuan migrasi saat graduation. */
  cpConfigId: string;
  /** Creator fee CPMM sesudah graduate (rate per 1_000_000), dari config CPMM. */
  cpmmCreatorFeeRate: number;
  /** Platform membatasi global config yang boleh dipakai (`restrictGlobalConfig`). */
  restrictsGlobalConfig: boolean;
  fetchedAt: string;
}

/** Pair dari "supported-pairs endpoint" (devnet: hasil pemindaian global config on-chain). */
export interface StonkFunPair extends PairConfig {
  /** Global config ada dan pair boleh dipakai launch saat ini. */
  launchable: boolean;
  /** Config kompatibel dengan alur launch LIFTOFF (kurva, program token quote, batasan). */
  launchLabReady: boolean;
  /** Alasan tidak launchable / tidak ready, untuk UI. null jika siap. */
  unavailableReason: string | null;
  /** Aset saham tokenized (SPYx, NVDAx, …). */
  tokenized: boolean;
  /** `curveType` global config (0 = constant product, satu-satunya yang didukung). */
  curveType: number;
  /** Program token quote mint (SPL klasik / Token-2022, mis. xStocks). null = belum diketahui. */
  quoteTokenProgram: string | null;
  /**
   * Target graduation (raise) mentah dalam desimal quote, dari adapter (devnet: emulasi kurva
   * setara USD; mainnet: `raise.raw.totalFundRaisingB` endpoint pricing). null = belum dibaca.
   */
  graduationRaw: string | null;
  /** Kategori StonkFun (`custom`, `xstock`, …). null = tidak dilaporkan (devnet). */
  category: string | null;
  categoryLabel: string | null;
  /** Logo dari StonkFun (URL absolut). */
  logoUrl: string | null;
  /** Simbol dipakai lebih dari satu mint (`symbolAmbiguous` StonkFun). */
  symbolAmbiguous: boolean;
  /** Peringatan untuk pengguna sebelum konfirmasi. */
  warnings: string[];
}

/** Program token base mint launch. StonkFun hanya mengadopsi Token-2022 (6 desimal). */
export type BaseTokenProgram = "spl" | "token2022";

/**
 * Parameter create LaunchLab untuk SATU launch (StonkFun `GET /launchlab/pricing?quoteMint=`).
 * Launch builder memakai nilai ini apa adanya (bukan konstanta SDK): raise mentah dalam desimal
 * quote, configId, platform mode standard, dan akun curve-rule sebagai akun terakhir.
 * Nominal mentah = string desimal (aman diserialisasi).
 */
export interface StonkFunLaunchPricing {
  source: StonkFunSource;
  quoteMint: string;
  launchlabProgram: string;
  configId: string;
  /** Platform id mode standard (LIFTOFF tidak memakai mode reward / transfer tax). */
  platformId: string;
  /** Akun curve-rule platform (akun terakhir, read-only). null = platform tidak memakainya. */
  curveRuleId: string | null;
  /**
   * Akun allow-config platform: PDA `["platform_allow_config", platform, global_config]` program
   * LaunchLab, read-only, TEPAT SEBELUM curve-rule. null = tidak disertakan.
   */
  allowConfigId: string | null;
  /** StonkFun mewajibkan akun allow-config untuk mode ini (`allowConfig.required[mode]`). */
  allowConfigRequired: boolean;
  /**
   * `allowConfig.available[mode]`: false = platform menolak quote ini sekarang (allowlist aktif
   * dan akun tidak ada) → launch ditolak. null = tidak diketahui (platform tidak terbaca).
   */
  allowConfigAvailable: boolean | null;
  /** Tipe kurva (`curve.curveType`); LIFTOFF hanya mendukung `ConstantCurve`. */
  curveType: string;
  /** Mode standard StonkFun meminta extension transfer fee (harus false: mint tanpa transfer fee). */
  standardTransferFee: boolean;
  /** Market cap awal & graduation (USD) menurut StonkFun; null = tidak dilaporkan (devnet). */
  marketCapUsd: { start: number; graduation: number } | null;
  supply: string;
  totalSellA: string;
  totalFundRaisingB: string;
  baseDecimals: number;
  baseTokenProgram: BaseTokenProgram;
  /** Harus `cpmm` (syarat adopsi); nilai lain dilaporkan apa adanya agar launch ditolak. */
  migrateType: string;
  /** `CpmmCreatorFeeOn` Raydium (0 = kedua sisi, 1 = token0, 2 = token1). */
  cpmmCreatorFeeOn: number;
  /** Waktu harga acuan raise (mainnet: `prices.observedAt`). */
  observedAt: string | null;
}

/** Cara creator fee sampai ke master wallet (lihat docs/BUILD_PLAN.md "Fee intake"). */
export type FeeIntakeMode = "claim" | "forwarded";

/** Creator fee yang menunggu untuk sebuah token (StonkFun `GET /tokens/{mint}/fees`). */
export interface CreatorFeeStatus {
  source: StonkFunSource;
  mint: string;
  /** null = tidak ada yang bisa di-claim (mis. diteruskan otomatis) — lihat `reason`. */
  claimable: { base: string; quote: string } | null;
  /** `creator-quote-vault` = jumlah mencakup SEMUA launch creator untuk quote ini (launch lama). */
  scope: "token" | "creator-quote-vault" | null;
  reason: string | null;
  checkedAt: string;
}

/** Aset yang Spec minta tetapi tidak ditemukan config-nya (mis. saham tokenized di devnet). */
export interface UnavailableAsset {
  symbol: string;
  reason: string;
}

export interface StonkFunPairList {
  source: StonkFunSource;
  pairs: StonkFunPair[];
  unavailable: UnavailableAsset[];
  fetchedAt: string;
}

export type AdoptionState = "adopted" | "pending" | "not_found";

/** Status adopsi token oleh StonkFun (Spec §4 langkah 8). */
export interface AdoptionStatus {
  source: StonkFunSource;
  mint: string;
  state: AdoptionState;
  /** Pool LaunchLab yang dipakai untuk menilai adopsi. */
  pool: string | null;
  detail: string;
  checkedAt: string;
}

/** Tujuan creator fee (Spec §9 langkah 3). */
export interface CreatorFeeDestination {
  source: StonkFunSource;
  /** Creator semua koin = master wallet (launch authority, Spec §5). */
  creator: string;
  /** Vault creator fee curve LaunchLab untuk quote mint ini (diklaim oleh creator). */
  curveVault: string;
  /** Penerima creator fee pool CPMM sesudah graduate (`poolCreator`). */
  cpmmRecipient: string;
}

export interface StonkFunAdapter {
  readonly source: StonkFunSource;
  /** false = belum aktif (mainnet terkunci); semua method melempar StonkFunUnavailableError. */
  readonly active: boolean;
  /** `claim` (devnet, Tahap 7) atau `forwarded` (StonkFun: fee diteruskan otomatis). */
  readonly feeIntake: FeeIntakeMode;
  activeLaunchConfig(): Promise<StonkFunLaunchConfig>;
  /** Daftar pair TANPA pricing per pair (BUILD_PLAN §7n): murah, satu request. */
  listPairs(): Promise<StonkFunPairList>;
  /**
   * Melengkapi SATU pair yang dipilih: global config, raise, dan pemeriksaan quote mint on-chain.
   * Pair yang gagal diperiksa kembali dengan `launchLabReady: false` + alasan. Hasil di-cache.
   */
  resolvePair(pair: StonkFunPair): Promise<StonkFunPair>;
  /** Parameter create untuk pair ini (raise, configId, platform, curve-rule). */
  launchPricing(pair: StonkFunPair): Promise<StonkFunLaunchPricing>;
  adoptionStatus(mint: string, quoteMint: string): Promise<AdoptionStatus>;
  creatorFeeDestination(quoteMint: string): Promise<CreatorFeeDestination>;
  creatorFees(mint: string): Promise<CreatorFeeStatus>;
  /** `prices.solUsd` + `prices.observedAt` respons pricing. Devnet tidak punya (harga asumsi). */
  solUsdObservation?(): Promise<PriceObservation>;
  /** `prices.quoteUsd` + `prices.observedAt` respons pricing quote ini. */
  quoteUsdObservation?(quoteMint: string): Promise<PriceObservation>;
}

/** StonkFun (atau emulasinya) tidak bisa memberi config/pair yang dibutuhkan → launch ditolak aman. */
export class StonkFunUnavailableError extends Error {
  constructor(
    /** `rpc_unavailable` = gangguan sementara (RPC / API StonkFun), boleh dicoba lagi. */
    readonly code: "not_active" | "pair_unavailable" | "config_changed" | "rpc_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "StonkFunUnavailableError";
  }
}

/**
 * Sidik jari config yang dipakai sebuah launch: platform, fee, config CPMM, global config pair,
 * dan parameter quote. Disimpan di launch job saat divalidasi; worker menolak membangun
 * transaksi jika sidik jari saat ini berbeda (Spec §4: "fail safely if ... configuration has
 * changed"). String biasa (bukan hash) agar bisa dibaca saat audit.
 */
export function launchFingerprint(
  config: StonkFunLaunchConfig,
  pair: StonkFunPair,
  pricing?: StonkFunLaunchPricing,
): string {
  const parts = [
    config.source,
    config.launchlabProgram,
    config.platformId,
    `fee:${config.platformFeeRate}`,
    `creator:${config.creatorFeeRate}`,
    `cp:${config.cpConfigId}`,
    `cfg:${pair.configId}`,
    `mint:${pair.mint}`,
    `dec:${pair.decimals}`,
    `curve:${pair.curveType}`,
    `minRaise:${pair.minFundRaisingRaw}`,
  ];
  if (pricing) {
    parts.push(
      `base:${pricing.baseTokenProgram}/${pricing.baseDecimals}`,
      `supply:${pricing.supply}/${pricing.totalSellA}`,
      // Raise non-SOL ikut harga (setara 85 SOL), jadi berubah wajar antara validasi & pengiriman.
      // Launch selalu memakai pricing terbaru; yang dijaga di sini hanya config.
      ...(pair.mint === WSOL_MINT || config.source !== "stonkfun_mainnet"
        ? [`raise:${pricing.totalFundRaisingB}`]
        : []),
      `rule:${pricing.curveRuleId ?? "-"}`,
      `cpfee:${pricing.cpmmCreatorFeeOn}`,
    );
    // Hanya bila ada: sidik jari job lama (sebelum allow-config) tetap cocok.
    if (pricing.allowConfigId) parts.push(`allow:${pricing.allowConfigId}`);
  }
  return parts.join("|");
}

/** Desimal base mint yang disyaratkan StonkFun untuk adopsi. */
export const STONKFUN_BASE_DECIMALS = 6;

/**
 * Syarat adopsi StonkFun untuk launch yang dibangun sendiri (Developer API): configId pair sama,
 * migrasi CPMM, kurva ConstantCurve, supply & totalSellA sah, raise positif, base mint Token-2022
 * 6 desimal tanpa transfer fee, platform id mode standard, akun allow-config (bila diwajibkan;
 * platform tidak boleh menolak quote ini) dan akun curve-rule (wajib di mainnet).
 * `requireCurveRule` = mode ketat mainnet: ketersediaan allow-config yang tidak diketahui juga
 * ditolak. [] = memenuhi syarat.
 */
export function adoptionRequirementViolations(
  pricing: StonkFunLaunchPricing,
  pair: Pick<StonkFunPair, "configId" | "mint">,
  opts: { requireCurveRule: boolean },
): string[] {
  const v: string[] = [];
  const raw = (s: string) => (/^[0-9]+$/.test(s) ? BigInt(s) : -1n);
  if (pricing.quoteMint !== pair.mint) v.push("pricing is for a different quote mint");
  if (pricing.configId !== pair.configId) v.push("pricing configId differs from the pair config");
  if (pricing.migrateType !== "cpmm") v.push("migration must be CPMM");
  const supply = raw(pricing.supply);
  const sell = raw(pricing.totalSellA);
  if (supply <= 0n) v.push("supply must be positive");
  if (sell <= 0n || sell > supply) v.push("totalSellA must be positive and ≤ supply");
  if (raw(pricing.totalFundRaisingB) <= 0n) v.push("raise (totalFundRaisingB) must be positive");
  if (pricing.baseDecimals !== STONKFUN_BASE_DECIMALS) v.push("base mint must have 6 decimals");
  if (pricing.baseTokenProgram !== "token2022") v.push("base mint must be Token-2022");
  if (!pricing.platformId) v.push("standard platform id is missing");
  if (opts.requireCurveRule && !pricing.curveRuleId) v.push("curve-rule account is missing");
  if (pricing.curveType !== "ConstantCurve")
    v.push(`curve type ${pricing.curveType} is not supported`);
  if (pricing.standardTransferFee) v.push("standard mode asks for a transfer fee extension");
  if (pricing.allowConfigRequired && !pricing.allowConfigId) {
    v.push("allow-config account is missing");
  }
  if (pricing.allowConfigAvailable === false) {
    v.push("the StonkFun platform does not allow this quote right now (allow-config)");
  } else if (opts.requireCurveRule && pricing.allowConfigAvailable === null) {
    v.push("the StonkFun platform allow-list could not be read");
  }
  return v;
}

/**
 * Pair yang boleh dipakai launch. Melempar `StonkFunUnavailableError` dengan pesan yang aman
 * ditampilkan jika tidak ada, tidak launchable, atau tidak LaunchLab-ready.
 * `mint` melengkapi `configId`: daftar mainnet belum memuat config sebelum pair di-resolve.
 */
export function requireLaunchablePair(
  list: StonkFunPairList,
  match: { id?: string; configId?: string; mint?: string },
): StonkFunPair {
  const pair =
    match.configId !== undefined
      ? (list.pairs.find((p) => p.configId === match.configId) ??
        list.pairs.find((p) => p.mint === match.mint && p.configId === ""))
      : list.pairs.find((p) => p.id === match.id);
  if (!pair) {
    throw new StonkFunUnavailableError(
      "pair_unavailable",
      "This trading pair is not offered by StonkFun right now.",
    );
  }
  if (!pair.launchable || !pair.launchLabReady) {
    throw new StonkFunUnavailableError(
      "pair_unavailable",
      pair.unavailableReason ?? `${pair.symbol} is not launchable right now.`,
    );
  }
  return pair;
}

/**
 * Adapter statis untuk test & development tanpa RPC: semua pair registri launchable, config
 * dari nilai yang diberikan. Bisa diubah di test (`pairs`, `config`) untuk mensimulasikan pair
 * yang hilang atau config yang berubah.
 */
export class StaticStonkFunAdapter implements StonkFunAdapter {
  readonly source = "devnet_emulation" as const;
  readonly active = true;
  feeIntake: FeeIntakeMode = "claim";
  config: StonkFunLaunchConfig;
  pairs: StonkFunPair[];
  adopted = true;
  baseTokenProgram: BaseTokenProgram = "token2022";
  fees = new Map<string, CreatorFeeStatus>();

  constructor(
    cluster: SolanaCluster = "devnet",
    fees = { platformFeeRate: 10_000, creatorFeeRate: 5_000 },
  ) {
    const platform = platformFor(cluster);
    this.config = {
      source: this.source,
      launchlabProgram: platform.launchlabProgram,
      platformId: platform.platformId,
      ...fees,
      cpConfigId: "5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy",
      cpmmCreatorFeeRate: 2_500,
      restrictsGlobalConfig: false,
      fetchedAt: new Date(0).toISOString(),
    };
    this.pairs = pairsFor(cluster).map((p) => ({
      ...p,
      launchable: true,
      launchLabReady: p.supported,
      unavailableReason: p.supported ? null : "Not supported.",
      tokenized: false,
      curveType: 0,
      quoteTokenProgram: null,
      graduationRaw: p.supported ? curveParamsFor(p).totalFundRaisingB.toString() : null,
      category: null,
      categoryLabel: null,
      logoUrl: null,
      symbolAmbiguous: false,
      warnings: [],
    }));
  }

  resolvePair(pair: StonkFunPair): Promise<StonkFunPair> {
    return Promise.resolve(pair);
  }

  launchPricing(pair: StonkFunPair): Promise<StonkFunLaunchPricing> {
    return Promise.resolve(
      emulatedPricing(this.config, pair, { curveRuleId: null }, this.baseTokenProgram),
    );
  }

  creatorFees(mint: string): Promise<CreatorFeeStatus> {
    return Promise.resolve(
      this.fees.get(mint) ?? {
        source: this.source,
        mint,
        claimable: null,
        scope: null,
        reason: "static",
        checkedAt: this.config.fetchedAt,
      },
    );
  }

  activeLaunchConfig() {
    return Promise.resolve({ ...this.config });
  }
  listPairs(): Promise<StonkFunPairList> {
    return Promise.resolve({
      source: this.source,
      pairs: this.pairs.map((p) => ({ ...p })),
      unavailable: [
        { symbol: "NVDAx", reason: "No LaunchLab global config for this asset on devnet." },
      ],
      fetchedAt: this.config.fetchedAt,
    });
  }
  adoptionStatus(mint: string): Promise<AdoptionStatus> {
    return Promise.resolve({
      source: this.source,
      mint,
      state: this.adopted ? "adopted" : "not_found",
      pool: null,
      detail: "static",
      checkedAt: this.config.fetchedAt,
    });
  }
  creatorFeeDestination(): Promise<CreatorFeeDestination> {
    const master = platformFor("devnet").masterWallet;
    return Promise.resolve({
      source: this.source,
      creator: master,
      curveVault: master,
      cpmmRecipient: master,
    });
  }
}

/** Akun tambahan create (allow-config + curve-rule) untuk pricing emulasi. */
export interface EmulatedLaunchAccounts {
  curveRuleId: string | null;
  allowConfigId?: string | null;
  allowConfigAvailable?: boolean | null;
}

/**
 * "Endpoint pricing" emulasi devnet: kurva setara USD LIFTOFF (curveParamsFor, harga asumsi pair)
 * di platform tiruan. Base mint Token-2022 6 desimal seperti syarat adopsi StonkFun; allow-config
 * disertakan bila emulasi memberikannya (seperti `allowConfig.required.standard` StonkFun).
 */
export function emulatedPricing(
  config: StonkFunLaunchConfig,
  pair: StonkFunPair,
  accounts: EmulatedLaunchAccounts,
  baseTokenProgram: BaseTokenProgram = "token2022",
): StonkFunLaunchPricing {
  const curve = curveParamsFor(pair);
  return {
    source: config.source,
    quoteMint: pair.mint,
    launchlabProgram: config.launchlabProgram,
    configId: pair.configId,
    platformId: config.platformId,
    curveRuleId: accounts.curveRuleId,
    allowConfigId: accounts.allowConfigId ?? null,
    allowConfigRequired: !!accounts.allowConfigId,
    allowConfigAvailable: accounts.allowConfigId ? (accounts.allowConfigAvailable ?? true) : true,
    curveType: "ConstantCurve",
    standardTransferFee: false,
    marketCapUsd: null,
    supply: curve.supply.toString(),
    totalSellA: curve.totalSellA.toString(),
    totalFundRaisingB: curve.totalFundRaisingB.toString(),
    baseDecimals: curve.tokenDecimals,
    baseTokenProgram,
    migrateType: "cpmm",
    cpmmCreatorFeeOn: 0,
    observedAt: null,
  };
}
