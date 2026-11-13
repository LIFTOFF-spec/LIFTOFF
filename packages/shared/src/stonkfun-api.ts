/**
 * MainnetStonkFunAdapter — klien StonkFun Developer API (https://www.stonkfun.xyz/developers,
 * OpenAPI `/api/public/v1/openapi.json`, server `https://www.stonkfun.xyz`).
 *
 * TERKUNCI: `active` hanya true bila cluster `mainnet-beta` DAN flag eksplisit
 * (`STONKFUN_MAINNET_ENABLED=1`, Tahap 10). Selama terkunci SEMUA method menolak dengan
 * `not_active` SEBELUM ada request HTTP. Tidak ada API key; rate limit per IP (umum 300/menit),
 * jadi klien memberi jarak antar-request, menghormati `Retry-After` / `retryAfterSeconds`, dan
 * memakai timeout. Error API berbentuk `{ error: { code, message, retryable, retryAfterSeconds } }`.
 *
 * Skema OpenAPI hanya mendeklarasikan `data: object`, jadi bentuk `data` di bawah disusun dari
 * deskripsi endpoint resmi (field yang disebut dokumen) dan divalidasi dengan Zod secara toleran
 * (field lain dibiarkan). Fixture test: src/__fixtures__/stonkfun/*.json. Nama field yang belum
 * pernah terlihat di respons asli ditandai "dikonfirmasi di Tahap 10" di docs/BUILD_PLAN.md.
 *
 * Hal yang butuh RPC (fee rate platform on-chain, PDA vault creator) disuntikkan lewat `onchain`
 * oleh packages/solana, sehingga modul ini tetap tanpa web3.
 */
import { z } from "zod";
import type { SolanaCluster } from "./cluster";
import { CUSTOM_PAIR_WARNING, NON_SOL_CLOSED_MESSAGE, WSOL_MINT, type PairAccess } from "./pairs";
import {
  JupiterPriceBatch,
  JupiterPriceSource,
  parseStonkFunPrices,
  parseStonkFunQuotePrice,
  QuotePriceBook,
  SolPriceOracle,
  type PriceObservation,
  type SolPriceSettings,
} from "./sol-price";
import {
  StonkFunUnavailableError,
  type AdoptionStatus,
  type CreatorFeeDestination,
  type CreatorFeeStatus,
  type StonkFunAdapter,
  type StonkFunLaunchConfig,
  type StonkFunLaunchPricing,
  type StonkFunPair,
  type StonkFunPairList,
} from "./stonkfun";

export const STONKFUN_API_BASE_URL = "https://www.stonkfun.xyz";
const PREFIX = "/api/public/v1";

// ------------------------------------------------------------------ skema (Zod)

const raw = z
  .union([z.string().regex(/^[0-9]+$/), z.number().int().nonnegative(), z.bigint()])
  .transform((v) => v.toString());
const intLike = z.union([z.number().int(), z.string().regex(/^-?[0-9]+$/)]).transform(Number);
const address = z.string().min(32).max(44);

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum([
      "invalid_request",
      "forbidden",
      "not_found",
      "method_not_allowed",
      "conflict",
      "rate_limited",
      "internal",
      "service_unavailable",
    ]),
    message: z.string(),
    retryable: z.boolean().optional(),
    retryAfterSeconds: z.number().int().nonnegative().optional(),
  }),
});

/** Satu pair dari `GET /pairs`. `launchLabReady` absen (bukan false) bila probe tidak jalan. */
export const pairSchema = z
  .object({
    quoteMint: address.optional(),
    mint: address.optional(),
    symbol: z.string(),
    name: z.string().optional(),
    category: z.string().optional(),
    categoryLabel: z.string().optional(),
    logoUrl: z.string().nullish(),
    symbolAmbiguous: z.boolean().optional(),
    decimals: z.number().int().min(0).max(18).optional(),
    tokenProgram: address.optional(),
    launchable: z.boolean(),
    launchLabReady: z.boolean().optional(),
  })
  .passthrough()
  .refine((p) => !!(p.quoteMint ?? p.mint), { message: "pair tanpa quoteMint" });

const listOf = <T extends z.ZodTypeAny>(item: T, keys: string[]) =>
  z.union([
    z.array(item),
    z
      .record(z.string(), z.unknown())
      .transform((o, ctx) => {
        for (const k of keys) if (Array.isArray(o[k])) return o[k];
        ctx.addIssue({ code: "custom", message: `daftar tidak ditemukan (${keys.join("/")})` });
        return z.NEVER;
      })
      .pipe(z.array(item)),
  ]);

export const pairsResponseSchema = z.object({ data: listOf(pairSchema, ["pairs", "items"]) });

/** Per mode StonkFun (`standard` / `reward` / `community`). */
const perMode = <T extends z.ZodTypeAny>(item: T) =>
  z
    .object({ standard: item.optional(), reward: item.optional(), community: item.optional() })
    .passthrough();

/**
 * `GET /launchlab/pricing?quoteMint=` — bentuk respons ASLI (diambil pemilik 2026-10-31,
 * src/__fixtures__/stonkfun/pricing-sol-mainnet-2026-10-31.json). `raise.raw` = raise mentah
 * (string) dalam desimal quote, dipetakan ke `totalFundRaisingB`; bentuk lama dari dokumen
 * (`raise.raw.totalFundRaisingB`) masih diterima. Quote mint ada di `quote.mint`.
 */
export const pricingSchema = z
  .object({
    quoteMint: address.optional(),
    quote: z
      .object({
        mint: address,
        decimals: z.number().int().min(0).max(18).optional(),
        tokenProgram: address.optional(),
      })
      .passthrough()
      .optional(),
    curve: z
      .object({
        programId: address,
        configId: address,
        supply: raw,
        totalSellA: raw,
        baseDecimals: z.number().int(),
        cpmmCreatorFeeOn: intLike,
        migrateType: z.string().optional(),
        curveType: z.string().optional(),
        derived: z.object({ virtualA: raw, virtualB: raw }).passthrough().nullish(),
      })
      .passthrough(),
    raise: z
      .object({
        raw: z.union([raw, z.object({ totalFundRaisingB: raw }).passthrough()]),
        units: z.number().nullish(),
        minimumRaw: raw.nullish(),
      })
      .passthrough()
      .transform(({ raw: r, ...rest }) => ({
        ...rest,
        totalFundRaisingB: typeof r === "string" ? r : r.totalFundRaisingB,
      })),
    marketCap: z
      .object({ startUsd: z.number(), graduationUsd: z.number() })
      .passthrough()
      .nullish(),
    standardV2Enabled: z.boolean().nullish(),
    platform: z
      .object({ standard: address, reward: address.nullish(), community: address.nullish() })
      .passthrough(),
    allowConfig: z
      .object({
        required: perMode(z.boolean().nullable()).nullish(),
        available: perMode(z.boolean().nullable()).nullish(),
        standard: address.nullish(),
        reward: address.nullish(),
        community: address.nullish(),
      })
      .passthrough()
      .nullish(),
    curveRule: z
      .object({ standard: address.nullish(), reward: address.nullish() })
      .passthrough()
      .nullish(),
    modes: z
      .object({
        standard: z.object({ transferFee: z.unknown().optional() }).passthrough().nullish(),
      })
      .passthrough()
      .nullish(),
    prices: z.object({ observedAt: z.string().nullish() }).passthrough().nullish(),
  })
  .passthrough()
  .refine((d) => !!(d.quote?.mint ?? d.quoteMint), { message: "pricing tanpa quote mint" });
export const pricingResponseSchema = z.object({ data: pricingSchema });

const launchRecord = z
  .object({
    mint: address,
    creator: address.nullish(),
    launchpad: z.string().nullish(),
    mode: z.string().nullish(),
  })
  .passthrough();

/** `GET /tokens/{mint}`: `token` data pasar + `launch` catatan launch; 404 bila bukan pool platform. */
export const tokenResponseSchema = z.object({
  data: z
    .object({
      token: z.object({ mint: address, launchpad: z.string().nullish() }).passthrough(),
      launch: launchRecord.partial().passthrough().nullish(),
    })
    .passthrough(),
});

export const launchesResponseSchema = z.object({
  data: listOf(launchRecord, ["launches", "items"]),
});

/** `GET /tokens/{mint}/fees`: claimable base & quote, atau null + alasan. */
export const feesResponseSchema = z.object({
  data: z
    .object({
      claimable: z.object({ base: raw, quote: raw }).passthrough().nullable(),
      reason: z.string().nullish(),
      scope: z.string().nullish(),
    })
    .passthrough(),
});

// ------------------------------------------------------------------ HTTP

export class StonkFunApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "StonkFunApiError";
  }
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface StonkFunHttpOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Jarak minimum antar-request (default 250 ms ≈ 240/menit, di bawah batas 300/menit). */
  minIntervalMs?: number;
  /** Percobaan ulang untuk 429/5xx/timeout (default 2). */
  maxRetries?: number;
  /** Batas atas tunggu Retry-After (default 60 s); lebih lama → gagal sementara. */
  maxRetryAfterMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Klien HTTP kecil: GET JSON + validasi Zod + rate limit + Retry-After + timeout. */
export class StonkFunHttp {
  private readonly o: Required<Omit<StonkFunHttpOptions, "fetch">> & { fetch: FetchLike };
  private nextAt = 0;
  /** Batas dari `Retry-After` yang melewati jatah tunggu: sebelum ini tidak ada request sama sekali. */
  private blockedUntil = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: StonkFunHttpOptions = {}) {
    this.o = {
      baseUrl: opts.baseUrl ?? STONKFUN_API_BASE_URL,
      fetch: opts.fetch ?? (globalThis.fetch as unknown as FetchLike),
      timeoutMs: opts.timeoutMs ?? 8_000,
      minIntervalMs: opts.minIntervalMs ?? 250,
      maxRetries: opts.maxRetries ?? 2,
      maxRetryAfterMs: opts.maxRetryAfterMs ?? 60_000,
      now: opts.now ?? Date.now,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    };
  }

  /** Request diserialkan & diberi jarak agar tidak melampaui rate limit per IP. */
  private async slot() {
    const wait = this.nextAt - this.o.now();
    if (wait > 0) await this.o.sleep(wait);
    this.nextAt = this.o.now() + this.o.minIntervalMs;
  }

  get<T extends z.ZodTypeAny>(
    path: string,
    query: Record<string, string | undefined>,
    schema: T,
  ): Promise<z.infer<T>> {
    const run = this.queue.then(() => this.getNow(path, query, schema));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async getNow<T extends z.ZodTypeAny>(
    path: string,
    query: Record<string, string | undefined>,
    schema: T,
  ): Promise<z.infer<T>> {
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v!)}`)
      .join("&");
    const url = `${this.o.baseUrl}${PREFIX}${path}${qs ? `?${qs}` : ""}`;
    if (this.o.now() < this.blockedUntil) {
      throw new StonkFunApiError(
        "rate_limited",
        429,
        "StonkFun API: menunggu Retry-After, request tidak dikirim",
        true,
      );
    }
    for (let attempt = 0; ; attempt++) {
      await this.slot();
      let res: Awaited<ReturnType<FetchLike>>;
      let body: string;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs);
      try {
        res = await this.o.fetch(url, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: ctrl.signal,
        });
        body = await res.text();
      } catch (err) {
        const timeout = ctrl.signal.aborted;
        if (attempt < this.o.maxRetries) continue;
        throw new StonkFunApiError(
          timeout ? "timeout" : "network",
          0,
          timeout ? `StonkFun API timeout (${this.o.timeoutMs} ms)` : (err as Error).message,
          true,
        );
      } finally {
        clearTimeout(timer);
      }
      let json: unknown = null;
      try {
        json = body ? JSON.parse(body) : null;
      } catch {
        json = null;
      }
      if (res.status >= 200 && res.status < 300) {
        const parsed = schema.safeParse(json);
        if (!parsed.success) {
          throw new StonkFunApiError(
            "invalid_response",
            res.status,
            `StonkFun ${path}: respons tidak sesuai skema (${parsed.error.issues
              .slice(0, 3)
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ")})`,
            false,
          );
        }
        return parsed.data;
      }
      const apiErr = apiErrorSchema.safeParse(json);
      const code = apiErr.success ? apiErr.data.error.code : `http_${res.status}`;
      const message = apiErr.success ? apiErr.data.error.message : `HTTP ${res.status}`;
      const retryable =
        (apiErr.success ? apiErr.data.error.retryable : undefined) ??
        (res.status === 429 || res.status >= 500);
      if (retryable && attempt < this.o.maxRetries) {
        const header = Number(res.headers.get("retry-after"));
        const seconds = apiErr.success ? apiErr.data.error.retryAfterSeconds : undefined;
        const waitMs = (seconds ?? (Number.isFinite(header) && header > 0 ? header : 1)) * 1000;
        if (waitMs <= this.o.maxRetryAfterMs) {
          await this.o.sleep(waitMs);
          continue;
        }
        this.blockedUntil = this.o.now() + waitMs;
      }
      throw new StonkFunApiError(code, res.status, message, retryable);
    }
  }
}

// ------------------------------------------------------------------ adapter

/** Kebutuhan on-chain yang disuntikkan packages/solana (tanpa web3 di sini). */
export interface StonkFunOnchain {
  launchlabProgram: string;
  masterWallet: string;
  platformConfig(platformId: string): Promise<{
    platformFeeRate: number;
    creatorFeeRate: number;
    cpConfigId: string;
    cpmmCreatorFeeRate: number;
    restrictsGlobalConfig: boolean;
  }>;
  creatorVault(quoteMint: string): string;
  /** Quote mint dibaca dari chain. `issue` = alasan LIFTOFF tidak bisa memakainya. null = tidak ada. */
  quoteMint(mint: string): Promise<{
    program: string;
    decimals: number;
    issue: string | null;
    warnings: string[];
  } | null>;
  /** PDA allow-config & curve-rule yang diturunkan lokal untuk (program, platform, config). */
  launchAccounts(
    programId: string,
    platformId: string,
    configId: string,
  ): { allowConfigId: string; curveRuleId: string };
}

/**
 * Respons pricing → parameter create. Mode LIFTOFF = `standard`. Bila `onchain` ada, alamat
 * allow-config & curve-rule dari API WAJIB sama dengan PDA turunan lokal (seed
 * `platform_allow_config` / `platform_curve_rule` + platform + global config); beda →
 * `config_changed` (launch ditolak, tidak ada dana keluar).
 */
export function pricingFromApi(
  d: z.infer<typeof pricingSchema>,
  quoteMint: string,
  onchain: Pick<StonkFunOnchain, "launchAccounts"> | null,
): StonkFunLaunchPricing {
  const apiQuote = d.quote?.mint ?? d.quoteMint;
  if (apiQuote !== quoteMint) {
    throw new StonkFunUnavailableError(
      "config_changed",
      "StonkFun pricing is for a different quote mint.",
    );
  }
  const platformId = d.platform.standard;
  const allowConfigId = d.allowConfig?.standard ?? null;
  const curveRuleId = d.curveRule?.standard ?? null;
  if (onchain) {
    const local = onchain.launchAccounts(d.curve.programId, platformId, d.curve.configId);
    if (allowConfigId !== null && allowConfigId !== local.allowConfigId) {
      throw new StonkFunUnavailableError(
        "config_changed",
        "StonkFun allow-config address does not match the locally derived account.",
      );
    }
    if (curveRuleId !== null && curveRuleId !== local.curveRuleId) {
      throw new StonkFunUnavailableError(
        "config_changed",
        "StonkFun curve-rule address does not match the locally derived account.",
      );
    }
  }
  const available = d.allowConfig ? d.allowConfig.available?.standard : undefined;
  const mc = d.marketCap;
  return {
    source: "stonkfun_mainnet",
    quoteMint,
    launchlabProgram: d.curve.programId,
    configId: d.curve.configId,
    platformId,
    curveRuleId,
    allowConfigId,
    allowConfigRequired: d.allowConfig?.required?.standard === true,
    // Absen / null = tidak diketahui (platform tidak terbaca) → ditolak di mode ketat.
    allowConfigAvailable: available ?? null,
    curveType: d.curve.curveType ?? "ConstantCurve",
    // `modes.standard.transferFee: null` = mint tanpa extension transfer fee.
    standardTransferFee: d.modes?.standard?.transferFee != null,
    marketCapUsd: mc ? { start: mc.startUsd, graduation: mc.graduationUsd } : null,
    supply: d.curve.supply,
    totalSellA: d.curve.totalSellA,
    // Raise mentah dalam desimal quote — BUKAN konstanta SDK Raydium.
    totalFundRaisingB: d.raise.totalFundRaisingB,
    baseDecimals: d.curve.baseDecimals,
    // Dokumen adopsi StonkFun: base mint Token-2022. Respons pricing hanya menyebut program
    // base untuk mode reward (Token-2022); untuk standard tidak dinyatakan (lihat BUILD_PLAN §6a).
    baseTokenProgram: "token2022",
    migrateType: d.curve.migrateType ?? "cpmm",
    cpmmCreatorFeeOn: d.curve.cpmmCreatorFeeOn,
    observedAt: d.prices?.observedAt ?? null,
  };
}

export interface MainnetStonkFunOptions extends StonkFunHttpOptions {
  cluster: SolanaCluster;
  /** Flag eksplisit Tahap 10 (`STONKFUN_MAINNET_ENABLED=1`). Default false. */
  enabled?: boolean;
  onchain?: StonkFunOnchain;
  /** Umur cache pairs/pricing (default 60 s). */
  cacheMs?: number;
  /** Batas waktu adopsi sebelum status `not_found` (dokumen: ±1–2 menit; default 10 menit). */
  adoptionWindowMs?: number;
  /** Tombol launch non-SOL (`PAIRS_NON_SOL_ENABLED`). Default tertutup. */
  access?: PairAccess;
}

export class MainnetStonkFunAdapter implements StonkFunAdapter {
  readonly source = "stonkfun_mainnet" as const;
  readonly feeIntake = "forwarded" as const;
  readonly active: boolean;
  private readonly http: StonkFunHttp;
  private readonly now: () => number;
  private readonly cacheMs: number;
  private readonly cache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(private readonly opts: MainnetStonkFunOptions) {
    this.active = opts.cluster === "mainnet-beta" && opts.enabled === true;
    this.http = new StonkFunHttp(opts);
    this.now = opts.now ?? Date.now;
    this.cacheMs = opts.cacheMs ?? 60_000;
  }

  /** Gerbang: ditolak sebelum request apa pun bila terkunci. */
  private guard(): StonkFunOnchain | null {
    if (!this.active) {
      throw new StonkFunUnavailableError(
        "not_active",
        "StonkFun mainnet integration is locked (needs SOLANA_CLUSTER=mainnet-beta and STONKFUN_MAINNET_ENABLED=1).",
      );
    }
    return this.opts.onchain ?? null;
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof StonkFunUnavailableError) throw err;
      if (err instanceof StonkFunApiError) {
        throw new StonkFunUnavailableError(
          err.retryable ? "rpc_unavailable" : "pair_unavailable",
          `StonkFun API: ${err.message} (${err.code})`,
        );
      }
      throw new StonkFunUnavailableError("rpc_unavailable", (err as Error).message);
    }
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.cacheMs) return hit.value as Promise<T>;
    const value = load();
    const entry = { at: this.now(), value };
    this.cache.set(key, entry);
    value.catch(() => {
      if (this.cache.get(key) === entry) this.cache.delete(key);
    });
    return value;
  }

  private pricingRaw(quoteMint: string) {
    return this.cached(`pricing:${quoteMint}`, () =>
      this.http.get("/launchlab/pricing", { quoteMint }, pricingResponseSchema).then((r) => r.data),
    );
  }

  /** Logo StonkFun berupa path relatif; selain itu tidak dipakai. */
  private logoOf(url: string | null | undefined): string | null {
    if (!url?.startsWith("/") || url.startsWith("//")) return null;
    return `${this.opts.baseUrl ?? STONKFUN_API_BASE_URL}${url}`;
  }

  /** Satu request `/pairs`, TANPA pricing per pair: pricing diambil saat pair dipilih (resolvePair). */
  async listPairs(): Promise<StonkFunPairList> {
    this.guard();
    return this.call(() =>
      this.cached("pairs", async () => {
        // Tanpa filter `launchable=true`: filter itu menghilangkan 24 pair yang barisnya launchable.
        // Tiap baris sudah membawa `launchable` & `launchLabReady`, jadi semua tampil dengan alasannya.
        const res = await this.http.get("/pairs", {}, pairsResponseSchema);
        const nonSol = this.opts.access?.nonSolEnabled === true;
        const pairs = res.data.map((p): StonkFunPair => {
          const mint = (p.quoteMint ?? p.mint)!;
          let reason: string | null = null;
          if (!p.launchable) reason = "StonkFun has retired this pair.";
          else if (p.launchLabReady === undefined)
            reason = "LaunchLab readiness is unknown right now.";
          else if (!p.launchLabReady) reason = "Raydium has no LaunchLab config for this pair yet.";
          else if (mint !== WSOL_MINT && !nonSol) reason = NON_SOL_CLOSED_MESSAGE;
          const ok = reason === null;
          return {
            id: `sf-${mint}`,
            symbol: p.symbol,
            name: p.name ?? p.symbol,
            configId: "",
            configIndex: 0,
            mint,
            // Dicocokkan dengan chain di resolvePair sebelum pair bisa dipakai.
            decimals: p.decimals ?? 0,
            supported: ok,
            referralSupported: false,
            minFundRaisingRaw: "0",
            assumedPriceUsd: 0,
            note: null,
            launchable: p.launchable,
            launchLabReady: ok,
            unavailableReason: reason,
            tokenized: p.category?.toLowerCase().includes("stock") ?? false,
            curveType: 0,
            quoteTokenProgram: p.tokenProgram ?? null,
            graduationRaw: null,
            category: p.category ?? null,
            categoryLabel: p.categoryLabel ?? null,
            logoUrl: this.logoOf(p.logoUrl),
            symbolAmbiguous: p.symbolAmbiguous === true,
            warnings: p.category === "custom" ? [CUSTOM_PAIR_WARNING] : [],
          };
        });
        const rank = (p: StonkFunPair) =>
          p.mint === WSOL_MINT ? 0 : p.category === "custom" ? 2 : 1;
        pairs.sort(
          (a, b) =>
            Number(b.supported) - Number(a.supported) ||
            rank(a) - rank(b) ||
            a.symbol.localeCompare(b.symbol),
        );
        return {
          source: this.source,
          pairs,
          unavailable: [],
          fetchedAt: new Date(this.now()).toISOString(),
        };
      }),
    );
  }

  /** Pricing + pemeriksaan mint untuk SATU pair; pair yang tidak lolos tampil dengan alasannya. */
  async resolvePair(pair: StonkFunPair): Promise<StonkFunPair> {
    const onchain = this.guard();
    return this.call(async () => {
      if (!pair.launchLabReady) return pair; // sudah tidak tersedia: tidak perlu request pricing
      const d = await this.pricingRaw(pair.mint);
      const filled: StonkFunPair = {
        ...pair,
        configId: d.curve.configId,
        minFundRaisingRaw: d.raise.minimumRaw ?? "0",
        graduationRaw: d.raise.totalFundRaisingB,
      };
      const unavailable = (reason: string): StonkFunPair => ({
        ...filled,
        supported: false,
        launchLabReady: false,
        unavailableReason: reason,
      });
      if (!onchain) return filled;
      const mint = await this.cached(`mint:${pair.mint}`, () => onchain.quoteMint(pair.mint));
      if (!mint) return unavailable("The quote mint was not found on-chain.");
      if (mint.issue) return unavailable(mint.issue);
      if (mint.decimals !== pair.decimals) {
        return unavailable("StonkFun reports different decimals than the quote mint on-chain.");
      }
      return {
        ...filled,
        quoteTokenProgram: mint.program,
        warnings: [...pair.warnings, ...mint.warnings],
      };
    });
  }

  async launchPricing(pair: StonkFunPair): Promise<StonkFunLaunchPricing> {
    this.guard();
    const onchain = this.opts.onchain ?? null;
    return this.call(async () => {
      const d = await this.pricingRaw(pair.mint);
      return pricingFromApi(d, pair.mint, onchain);
    });
  }

  /** Harga SOL/USD dari respons pricing yang sama dengan parameter launch (satu cache). */
  async solUsdObservation(): Promise<PriceObservation> {
    this.guard();
    return this.call(async () => parseStonkFunPrices((await this.pricingRaw(WSOL_MINT)).prices));
  }

  /** Harga USD sebuah quote dari respons pricing yang sama (satu cache per mint). */
  async quoteUsdObservation(quoteMint: string): Promise<PriceObservation> {
    this.guard();
    return this.call(async () =>
      parseStonkFunQuotePrice((await this.pricingRaw(quoteMint)).prices),
    );
  }

  /** Platform standard sama untuk semua pair; dibaca dari pricing SOL, bukan dari pair pertama. */
  async activeLaunchConfig(): Promise<StonkFunLaunchConfig> {
    const onchain = this.guard();
    return this.call(async () => {
      const pricing = await this.pricingRaw(WSOL_MINT);
      const platformId = pricing.platform.standard;
      const rates = onchain
        ? await onchain.platformConfig(platformId)
        : {
            platformFeeRate: 0,
            creatorFeeRate: 0,
            cpConfigId: "",
            cpmmCreatorFeeRate: 0,
            restrictsGlobalConfig: false,
          };
      return {
        source: this.source,
        launchlabProgram: pricing.curve.programId,
        platformId,
        ...rates,
        fetchedAt: new Date(this.now()).toISOString(),
      };
    });
  }

  /**
   * Adopsi (±1–2 menit setelah launch): `GET /tokens/{mint}` dengan `launchpad: "launchlab"`,
   * dicek silang dengan `GET /launches?creator=<master>`. 404 di dalam jendela adopsi = pending.
   */
  async adoptionStatus(
    mint: string,
    _quoteMint: string,
    launchedAt?: Date,
  ): Promise<AdoptionStatus> {
    const onchain = this.guard();
    return this.call(async () => {
      const checkedAt = new Date(this.now()).toISOString();
      const base = { source: this.source, mint, pool: null, checkedAt };
      let launchpad: string | null = null;
      try {
        const t = await this.http.get(`/tokens/${mint}`, {}, tokenResponseSchema);
        launchpad = t.data.token.launchpad ?? t.data.launch?.launchpad ?? null;
      } catch (err) {
        if (!(err instanceof StonkFunApiError && err.status === 404)) throw err;
      }
      if (launchpad === null && onchain) {
        const l = await this.http.get(
          "/launches",
          { creator: onchain.masterWallet, pageSize: "100" },
          launchesResponseSchema,
        );
        launchpad = l.data.find((r) => r.mint === mint)?.launchpad ?? null;
      }
      if (launchpad === "launchlab") {
        return {
          ...base,
          state: "adopted",
          detail: "StonkFun lists this token (launchpad launchlab).",
        };
      }
      const window = this.opts.adoptionWindowMs ?? 10 * 60_000;
      const young = !launchedAt || this.now() - launchedAt.getTime() < window;
      if (launchpad !== null) {
        return { ...base, state: "not_found", detail: `StonkFun lists launchpad "${launchpad}".` };
      }
      return young
        ? { ...base, state: "pending", detail: "Waiting for StonkFun adoption (~1–2 minutes)." }
        : { ...base, state: "not_found", detail: "StonkFun has not adopted this token." };
    });
  }

  async creatorFeeDestination(quoteMint: string): Promise<CreatorFeeDestination> {
    const onchain = this.guard();
    if (!onchain) {
      throw new StonkFunUnavailableError("not_active", "On-chain reader is not configured.");
    }
    return {
      source: this.source,
      creator: onchain.masterWallet,
      curveVault: onchain.creatorVault(quoteMint),
      cpmmRecipient: onchain.masterWallet,
    };
  }

  async creatorFees(mint: string): Promise<CreatorFeeStatus> {
    this.guard();
    return this.call(async () => {
      const r = await this.http.get(`/tokens/${mint}/fees`, {}, feesResponseSchema);
      const scope =
        r.data.scope === "creator-quote-vault"
          ? "creator-quote-vault"
          : r.data.claimable
            ? "token"
            : null;
      return {
        source: this.source,
        mint,
        claimable: r.data.claimable
          ? { base: r.data.claimable.base, quote: r.data.claimable.quote }
          : null,
        scope,
        reason: r.data.reason ?? null,
        checkedAt: new Date(this.now()).toISOString(),
      };
    });
  }
}

/**
 * Sumber harga SOL/USD proses ini: null di luar mainnet (devnet memakai harga asumsi). `stonkfun`
 * = adapter proses bila sudah ada, supaya pricing tidak diambil dua kali; tanpa itu dibuat klien
 * pembaca sendiri (worker economic, monitor), tetap terkunci selama flag belum menyala.
 */
export function createSolPriceOracle(
  cluster: SolanaCluster,
  settings: SolPriceSettings,
  stonkfun?: StonkFunAdapter,
): SolPriceOracle | null {
  if (cluster !== "mainnet-beta") return null;
  const source =
    stonkfun ?? new MainnetStonkFunAdapter({ cluster, enabled: settings.stonkfunEnabled });
  const jupiter = new JupiterPriceSource({
    baseUrl: settings.jupiterApiUrl,
    timeoutMs: settings.config.jupiterTimeoutMs,
  });
  return new SolPriceOracle({
    config: settings.config,
    stonkfun: () =>
      source.solUsdObservation
        ? source.solUsdObservation()
        : Promise.reject(new Error("adapter tidak memberi harga SOL/USD")),
    jupiter: () => jupiter.read(WSOL_MINT),
  });
}

/**
 * Harga quote selain SOL (StonkFun `prices.quoteUsd`, cek silang Jupiter). null di luar mainnet. Hanya
 * mint yang diminta yang dibaca, jadi jumlah pair di StonkFun tidak menambah request.
 */
export function createQuotePriceBook(
  cluster: SolanaCluster,
  settings: SolPriceSettings,
  stonkfun?: StonkFunAdapter,
): QuotePriceBook | null {
  if (cluster !== "mainnet-beta") return null;
  const source =
    stonkfun ?? new MainnetStonkFunAdapter({ cluster, enabled: settings.stonkfunEnabled });
  const jupiter = new JupiterPriceBatch({
    baseUrl: settings.jupiterApiUrl,
    timeoutMs: settings.config.jupiterTimeoutMs,
  });
  return new QuotePriceBook({
    config: settings.config,
    stonkfun: (mint) =>
      source.quoteUsdObservation
        ? source.quoteUsdObservation(mint)
        : Promise.reject(new Error("adapter tidak memberi harga quote")),
    jupiter: (mint) => jupiter.read(mint),
  });
}
