/**
 * DevnetStonkFunAdapter — emulasi StonkFun di devnet (keputusan D-S1, docs/BUILD_PLAN.md).
 *
 * StonkFun hanya ada di mainnet (Developer API: MainnetStonkFunAdapter, terkunci). Di devnet:
 *  - "config LaunchLab StonkFun"  = Platform PDA LIFTOFF (dibaca on-chain setiap kali, dengan
 *    cache singkat) + config CPMM tujuan migrasinya;
 *  - "supported-pairs endpoint"   = pemindaian SEMUA global config LaunchLab on-chain
 *    (getProgramAccounts), dicocokkan dengan registri label (pairs.ts) hanya untuk nama & harga
 *    acuan — ketersediaan selalu dari chain;
 *  - "adopsi token oleh StonkFun" = pool LaunchLab token ada dan memakai platform tiruan ini;
 *  - "tujuan creator fee"          = master wallet (creator semua koin) → vault creator curve
 *    per quote mint, dan `poolCreator` CPMM sesudah graduate. Fee masuk lewat claim (strategi
 *    `claim`), bukan diteruskan otomatis seperti StonkFun asli;
 *  - "endpoint pricing"            = kurva setara USD LIFTOFF + Platform PDA + allow-config PDA
 *    (selalu, seperti `allowConfig.required.standard` StonkFun asli) + curve-rule PDA bila platform
 *    membatasi parameter kurva; base mint Token-2022 6 desimal.
 */
import {
  CpmmConfigInfoLayout,
  getPdaCreatorVault,
  getPdaLaunchpadPoolId,
  LaunchpadConfig,
  LaunchpadPool,
  PlatformConfig,
} from "@raydium-io/raydium-sdk-v2";
import { PublicKey, type Connection } from "@solana/web3.js";
import {
  curveParamsFor,
  emulatedPricing,
  MainnetStonkFunAdapter,
  pairAccessFrom,
  pairsFor,
  SPEC_WATCHLIST_ASSETS,
  StonkFunUnavailableError,
  type AdoptionStatus,
  type CreatorFeeDestination,
  type CreatorFeeStatus,
  type StonkFunLaunchPricing,
  type StonkFunHttpOptions,
  type PlatformAddresses,
  type SolanaCluster,
  type StonkFunAdapter,
  type StonkFunLaunchConfig,
  type StonkFunPair,
  type StonkFunPairList,
} from "@liftoff/shared";

import { launchAccountPdas } from "./launchlab";
import {
  isTokenProgram,
  parseMintAccount,
  quoteWarnings,
  unsupportedQuoteReason,
} from "./token-program";
/** Satu-satunya kurva yang dihitung LIFTOFF (constant product, sama dengan PoC). */
const SUPPORTED_CURVE_TYPE = 0;

export interface DevnetStonkFunOptions {
  connection: Connection;
  platform: PlatformAddresses;
  cluster: SolanaCluster;
  /** Umur cache hasil baca on-chain. 0 = selalu baca ulang (dipakai worker sebelum launch). */
  cacheMs?: number;
  now?: () => number;
}

/** Cache promise dengan TTL; hasil gagal tidak disimpan. */
class TtlCache<T> {
  private entry: { at: number; value: Promise<T> } | null = null;
  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}
  get(load: () => Promise<T>): Promise<T> {
    if (this.entry && this.now() - this.entry.at < this.ttlMs) return this.entry.value;
    const value = load();
    const entry = { at: this.now(), value };
    this.entry = entry;
    value.catch(() => {
      if (this.entry === entry) this.entry = null;
    });
    return value;
  }
}

function short(addr: string) {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

/** Simbol aset tokenized (xStocks) yang dikenali dari label registri. */
const TOKENIZED = new Set<string>(SPEC_WATCHLIST_ASSETS.map((s) => s.toUpperCase()));

export class DevnetStonkFunAdapter implements StonkFunAdapter {
  readonly source = "devnet_emulation" as const;
  readonly active = true;
  readonly feeIntake = "claim" as const;
  private readonly now: () => number;
  private readonly configCache: TtlCache<StonkFunLaunchConfig>;
  private readonly pairCache: TtlCache<StonkFunPairList>;

  constructor(private readonly opts: DevnetStonkFunOptions) {
    if (opts.cluster !== "devnet") {
      throw new Error("DevnetStonkFunAdapter hanya untuk devnet (mainnet: MainnetStonkFunAdapter)");
    }
    this.now = opts.now ?? Date.now;
    const ttl = opts.cacheMs ?? 30_000;
    this.configCache = new TtlCache(ttl, this.now);
    this.pairCache = new TtlCache(ttl, this.now);
  }

  private async rpc<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof StonkFunUnavailableError) throw err;
      throw new StonkFunUnavailableError(
        "rpc_unavailable",
        `Could not read the StonkFun (devnet emulation) configuration: ${(err as Error).message}`,
      );
    }
  }

  activeLaunchConfig(): Promise<StonkFunLaunchConfig> {
    return this.configCache.get(() =>
      this.rpc(async () => {
        const { connection, platform } = this.opts;
        const info = await connection.getAccountInfo(
          new PublicKey(platform.platformId),
          "confirmed",
        );
        if (!info || info.owner.toBase58() !== platform.launchlabProgram) {
          throw new StonkFunUnavailableError(
            "not_active",
            "The StonkFun platform config (devnet emulation) was not found on-chain.",
          );
        }
        const cfg = PlatformConfig.decode(info.data);
        const cpInfo = await connection.getAccountInfo(cfg.cpConfigId, "confirmed");
        const cpmmCreatorFeeRate = cpInfo
          ? Number(CpmmConfigInfoLayout.decode(cpInfo.data).creatorFeeRate.toString())
          : 0;
        return {
          source: this.source,
          launchlabProgram: platform.launchlabProgram,
          platformId: platform.platformId,
          platformFeeRate: Number(cfg.feeRate.toString()),
          creatorFeeRate: Number(cfg.creatorFeeRate.toString()),
          cpConfigId: cfg.cpConfigId.toBase58(),
          cpmmCreatorFeeRate,
          restrictsGlobalConfig: Number(cfg.restrictGlobalConfig) !== 0,
          fetchedAt: new Date(this.now()).toISOString(),
        };
      }),
    );
  }

  listPairs(): Promise<StonkFunPairList> {
    return this.pairCache.get(() =>
      this.rpc(async () => {
        const { connection, platform, cluster } = this.opts;
        const launch = await this.activeLaunchConfig();
        const accounts = await connection.getProgramAccounts(
          new PublicKey(platform.launchlabProgram),
          { commitment: "confirmed", filters: [{ dataSize: LaunchpadConfig.span }] },
        );
        const configs = accounts.map((a) => ({
          id: a.pubkey.toBase58(),
          cfg: LaunchpadConfig.decode(a.account.data),
        }));
        const mints = [...new Set(configs.map((c) => c.cfg.mintB.toBase58()))];
        const mintInfos = await connection.getMultipleAccountsInfo(
          mints.map((m) => new PublicKey(m)),
          "confirmed",
        );
        const accountOf = new Map(mints.map((m, i) => [m, mintInfos[i] ?? null]));
        // Platform dengan allowlist global config: pair hanya siap bila akun allow-config-nya ada.
        const allowed = new Set<string>();
        if (launch.restrictsGlobalConfig) {
          const ids = configs.map(
            ({ id }) =>
              launchAccountPdas(platform.launchlabProgram, platform.platformId, id).allowConfigId,
          );
          const infos = await connection.getMultipleAccountsInfo(
            ids.map((a) => new PublicKey(a)),
            "confirmed",
          );
          configs.forEach(({ id }, i) => {
            if (infos[i]?.owner.toBase58() === platform.launchlabProgram) allowed.add(id);
          });
        }
        const registry = pairsFor(cluster);

        const pairs: StonkFunPair[] = configs.map(({ id, cfg }) => {
          const mint = cfg.mintB.toBase58();
          const label = registry.find((p) => p.configId === id);
          const info = accountOf.get(mint);
          const mintInfo = info ? parseMintAccount(info.owner.toBase58(), info.data) : null;
          const decimals = mintInfo?.decimals ?? label?.decimals ?? 0;
          const base: StonkFunPair = {
            id: label?.id ?? `cfg-${id.slice(0, 6).toLowerCase()}`,
            symbol: label?.symbol ?? short(mint),
            name: label?.name ?? `Quote ${short(mint)} (config ${cfg.index})`,
            configId: id,
            configIndex: Number(cfg.index),
            mint,
            decimals,
            supported: false,
            referralSupported: Number(cfg.maxShareFeeRate.toString()) > 0,
            minFundRaisingRaw: cfg.minFundRaisingB.toString(),
            assumedPriceUsd: label?.assumedPriceUsd ?? 0,
            note: label?.note ?? null,
            launchable: true,
            launchLabReady: false,
            unavailableReason: null,
            tokenized: TOKENIZED.has((label?.symbol ?? "").toUpperCase()),
            curveType: Number(cfg.curveType),
            quoteTokenProgram: mintInfo?.program ?? null,
            graduationRaw: null,
            category: null,
            categoryLabel: null,
            logoUrl: null,
            symbolAmbiguous: false,
            warnings: mintInfo ? quoteWarnings(mintInfo) : [],
          };
          const reason = this.readiness(
            base,
            cfg,
            info?.owner.toBase58() ?? null,
            mintInfo,
            launch.restrictsGlobalConfig && !allowed.has(id),
            !!label,
          );
          return {
            ...base,
            launchLabReady: reason === null,
            supported: reason === null,
            unavailableReason: reason,
            graduationRaw:
              reason === null ? curveParamsFor(base).totalFundRaisingB.toString() : null,
          };
        });
        // Urutan: siap dulu, lalu urutan registri (SOL, USDC, …), config tak dikenal terakhir.
        const rank = (p: StonkFunPair) => {
          const i = registry.findIndex((r) => r.configId === p.configId);
          return i < 0 ? registry.length : i;
        };
        pairs.sort((a, b) => Number(b.supported) - Number(a.supported) || rank(a) - rank(b));
        const symbols = new Set(pairs.map((p) => p.symbol.toUpperCase()));
        return {
          source: this.source,
          pairs,
          unavailable: SPEC_WATCHLIST_ASSETS.filter((s) => !symbols.has(s.toUpperCase())).map(
            (symbol) => ({
              symbol,
              reason: "No LaunchLab global config for this asset on devnet.",
            }),
          ),
          fetchedAt: new Date(this.now()).toISOString(),
        };
      }),
    );
  }

  /** Pemindaian on-chain `listPairs` sudah memuat config & pemeriksaan mint. */
  resolvePair(pair: StonkFunPair): Promise<StonkFunPair> {
    return Promise.resolve(pair);
  }

  /** null = siap; selain itu alasan yang aman ditampilkan ke pengguna. */
  private readiness(
    pair: StonkFunPair,
    cfg: ReturnType<typeof LaunchpadConfig.decode>,
    mintOwner: string | null,
    mintInfo: ReturnType<typeof parseMintAccount>,
    notAllowed: boolean,
    known: boolean,
  ): string | null {
    if (notAllowed) {
      return "The platform restricts global configs; this pair needs an allow-list entry.";
    }
    if (mintOwner === null) return "The quote mint does not exist on this cluster.";
    if (!isTokenProgram(mintOwner) || !mintInfo) return "The quote mint is not a token mint.";
    // Quote Token-2022 (mis. xStocks) didukung; transfer fee / hook ditolak aman.
    const unsupported = unsupportedQuoteReason(mintInfo);
    if (unsupported) return unsupported;
    if (pair.curveType !== SUPPORTED_CURVE_TYPE) {
      return `Curve type ${pair.curveType} is not supported by LIFTOFF.`;
    }
    if (!known || !(pair.assumedPriceUsd > 0)) {
      return "No price reference for this quote asset, so LIFTOFF cannot size an equal-USD curve.";
    }
    // Parameter kurva LIFTOFF wajib memenuhi batasan global config (bukan di-hardcode buta).
    const curve = curveParamsFor(pair);
    if (curve.supply < BigInt(cfg.minSupplyA.toString())) {
      return "The curve supply is below this config's minimum.";
    }
    const sellRate = (curve.totalSellA * 1_000_000n) / curve.supply;
    if (sellRate < BigInt(cfg.minSellRateA.toString())) {
      return "The curve sell share is below this config's minimum.";
    }
    if (curve.totalFundRaisingB < BigInt(cfg.minFundRaisingB.toString())) {
      return "The graduation target is below this config's minimum raise.";
    }
    return null;
  }

  async adoptionStatus(mint: string, quoteMint: string): Promise<AdoptionStatus> {
    return this.rpc(async () => {
      const { connection, platform } = this.opts;
      const pool = getPdaLaunchpadPoolId(
        new PublicKey(platform.launchlabProgram),
        new PublicKey(mint),
        new PublicKey(quoteMint),
      ).publicKey;
      const info = await connection.getAccountInfo(pool, "confirmed");
      const checkedAt = new Date(this.now()).toISOString();
      const base = { source: this.source, mint, pool: pool.toBase58(), checkedAt };
      if (!info || info.owner.toBase58() !== platform.launchlabProgram) {
        return { ...base, pool: null, state: "not_found", detail: "No LaunchLab pool found." };
      }
      const decoded = LaunchpadPool.decode(info.data);
      if (decoded.platformId.toBase58() !== platform.platformId) {
        return {
          ...base,
          state: "not_found",
          detail: "The pool uses a different platform config.",
        };
      }
      return {
        ...base,
        state: "adopted",
        detail: "Pool uses the StonkFun platform config (devnet emulation: LIFTOFF Platform PDA).",
      };
    });
  }

  /**
   * Emulasi `GET /launchlab/pricing`: kurva setara USD + platform tiruan + allow-config (selalu
   * disertakan, seperti `allowConfig.required.standard` StonkFun) + curve-rule bila wajib.
   * `available` = akun allow-config ada ATAU platform tidak membatasi global config (aturan
   * StonkFun: false hanya bila allowlist aktif dan akunnya tidak ada).
   */
  async launchPricing(pair: StonkFunPair): Promise<StonkFunLaunchPricing> {
    return this.rpc(async () => {
      const config = await this.activeLaunchConfig();
      const { connection, platform } = this.opts;
      const pdas = launchAccountPdas(platform.launchlabProgram, platform.platformId, pair.configId);
      const [info, allow] = await connection.getMultipleAccountsInfo(
        [new PublicKey(platform.platformId), new PublicKey(pdas.allowConfigId)],
        "confirmed",
      );
      const decoded = info ? PlatformConfig.decode(info.data) : null;
      const restrictCurve = decoded ? Number(decoded.restrictCurveParam) !== 0 : false;
      const restrictConfig = decoded ? Number(decoded.restrictGlobalConfig) !== 0 : false;
      const allowExists = !!allow && allow.owner.toBase58() === platform.launchlabProgram;
      return emulatedPricing(
        config,
        pair,
        {
          curveRuleId: restrictCurve ? pdas.curveRuleId : null,
          allowConfigId: pdas.allowConfigId,
          allowConfigAvailable: allowExists || !restrictConfig,
        },
        "token2022",
      );
    });
  }

  /** Emulasi `GET /tokens/{mint}/fees`: devnet memakai claim, jadi vault creator per quote. */
  async creatorFees(mint: string): Promise<CreatorFeeStatus> {
    return {
      source: this.source,
      mint,
      claimable: null,
      scope: "creator-quote-vault",
      reason: "Devnet emulation: creator fees are claimed from the per-quote creator vault.",
      checkedAt: new Date(this.now()).toISOString(),
    };
  }

  async creatorFeeDestination(quoteMint: string): Promise<CreatorFeeDestination> {
    const { platform } = this.opts;
    return {
      source: this.source,
      creator: platform.masterWallet,
      curveVault: creatorFeeVault(platform, quoteMint),
      cpmmRecipient: platform.masterWallet,
    };
  }
}

/** Vault creator fee curve LaunchLab untuk (master wallet, quote mint). */
export function creatorFeeVault(platform: PlatformAddresses, quoteMint: string): string {
  return getPdaCreatorVault(
    new PublicKey(platform.launchlabProgram),
    new PublicKey(platform.masterWallet),
    new PublicKey(quoteMint),
  ).publicKey.toBase58();
}

export interface StonkFunFactoryOptions extends DevnetStonkFunOptions {
  /** Flag eksplisit Tahap 10 untuk StonkFun asli (`STONKFUN_MAINNET_ENABLED=1`). */
  mainnetEnabled?: boolean;
  http?: StonkFunHttpOptions;
}

/**
 * Adapter sesuai cluster: devnet = emulasi; selain itu = klien Developer API StonkFun yang
 * TERKUNCI kecuali cluster mainnet-beta + flag eksplisit (dan resolveCluster masih menolak
 * mainnet sampai Tahap 10).
 */
export function createStonkFunAdapter(opts: StonkFunFactoryOptions): StonkFunAdapter {
  if (opts.cluster === "devnet") return new DevnetStonkFunAdapter(opts);
  const { connection, platform } = opts;
  return new MainnetStonkFunAdapter({
    ...opts.http,
    cluster: opts.cluster,
    enabled: opts.mainnetEnabled === true,
    access: pairAccessFrom(),
    onchain: {
      launchlabProgram: platform.launchlabProgram,
      masterWallet: platform.masterWallet,
      creatorVault: (quoteMint) => creatorFeeVault(platform, quoteMint),
      launchAccounts: launchAccountPdas,
      async quoteMint(mint) {
        const info = await connection.getAccountInfo(new PublicKey(mint), "confirmed");
        const parsed = info ? parseMintAccount(info.owner.toBase58(), info.data) : null;
        if (!parsed) return null;
        return {
          program: parsed.program,
          decimals: parsed.decimals,
          issue: unsupportedQuoteReason(parsed),
          warnings: quoteWarnings(parsed),
        };
      },
      async platformConfig(platformId) {
        const info = await connection.getAccountInfo(new PublicKey(platformId), "confirmed");
        if (!info) throw new Error("StonkFun platform config not found on-chain");
        const cfg = PlatformConfig.decode(info.data);
        const cpInfo = await connection.getAccountInfo(cfg.cpConfigId, "confirmed");
        return {
          platformFeeRate: Number(cfg.feeRate.toString()),
          creatorFeeRate: Number(cfg.creatorFeeRate.toString()),
          cpConfigId: cfg.cpConfigId.toBase58(),
          cpmmCreatorFeeRate: cpInfo
            ? Number(CpmmConfigInfoLayout.decode(cpInfo.data).creatorFeeRate.toString())
            : 0,
          restrictsGlobalConfig: Number(cfg.restrictGlobalConfig) !== 0,
        };
      },
    },
  });
}
