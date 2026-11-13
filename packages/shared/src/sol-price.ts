/**
 * Harga SOL/USD mainnet (Tahap 11c, keputusan pemilik 2026-11-01, docs/BUILD_PLAN.md §8).
 *
 * Sumber utama: `prices.solUsd` + `prices.observedAt` dari `GET /launchlab/pricing` StonkFun (lewat
 * adapter, satu respons dipakai bersama parameter launch). Cek silang: Jupiter Price API (baca saja).
 *
 * ATURAN SATU SUMBER: keduanya WAJIB terbaca. Satu sumber saja tidak pernah dianggap terverifikasi,
 * karena satu sumber tidak bisa mendeteksi kesalahannya sendiri. Bacaan terakhir yang berhasil tetap
 * dipakai selama umurnya di bawah `maxAgeSeconds`, jadi satu kegagalan sesaat tidak membuat USD
 * berkedip. Bila umur lewat, sumber gagal lebih lama dari itu, atau selisih lewat `maxDeviationBps`:
 * `unverified`, USD `n/a` (bukan angka lama), deployment reserve ditahan, monitor mengirim alert.
 *
 * Devnet tidak memakai modul ini untuk harga: tetap harga ASUMSI pair berlabel MOCK.
 */
import { z } from "zod";
import type { SolanaCluster } from "./cluster";
import { pairForMint, WSOL_MINT } from "./pairs";
import type { FetchLike } from "./stonkfun-api";

export interface SolPriceConfig {
  /** Umur maksimum tiap sumber agar harga dianggap terverifikasi. */
  maxAgeSeconds: number;
  /** Selisih maksimum StonkFun vs Jupiter. */
  maxDeviationBps: number;
  /** Jarak antar-pembacaan. Satu pembacaan per proses, tidak per pair dan tidak per request. */
  refreshMs: number;
  /** `observedAt` di depan jam lokal lebih dari ini = respons tidak dipercaya. */
  maxFutureSkewSeconds: number;
  jupiterTimeoutMs: number;
}

/**
 * Terukur 2026-11-01 (BUILD_PLAN §7n): data StonkFun berumur 31–57 detik saat diterima, selisih
 * dengan Jupiter 0–10 bps. Dengan cache 60 detik, umur normal paling tua ±180 detik, jadi 240 detik
 * memberi ruang satu pembacaan gagal. Deployment reserve memakai batas lebih ketat sendiri
 * (`RESERVE_CONFIG.maxPriceAgeSeconds`). Status asumsi awal, dinilai ulang dengan data mainnet.
 */
export const SOL_PRICE_CONFIG: SolPriceConfig = {
  maxAgeSeconds: 240,
  maxDeviationBps: 150,
  refreshMs: 60_000,
  maxFutureSkewSeconds: 30,
  jupiterTimeoutMs: 8_000,
};

export const JUPITER_API_DEFAULT_URL = "https://lite-api.jup.ag";

export interface SolPriceSettings {
  config: SolPriceConfig;
  jupiterApiUrl: string;
  /** `STONKFUN_MAINNET_ENABLED=1`. Terkunci = tidak ada request StonkFun, harga `unverified`. */
  stonkfunEnabled: boolean;
}

function boundedInt(name: string, value: string | undefined, fallback: number, max: number) {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > max) {
    throw new Error(`${name} harus bilangan bulat 1..${max}`);
  }
  return n;
}

/** Override env + batas atas: batas selisih/umur yang kelewat longgar sama dengan tanpa batas. */
export function solPriceSettingsFrom(env: NodeJS.ProcessEnv = process.env): SolPriceSettings {
  const D = SOL_PRICE_CONFIG;
  return {
    config: {
      ...D,
      maxAgeSeconds: boundedInt(
        "SOL_PRICE_MAX_AGE_SECONDS",
        env.SOL_PRICE_MAX_AGE_SECONDS,
        D.maxAgeSeconds,
        900,
      ),
      maxDeviationBps: boundedInt(
        "SOL_PRICE_MAX_DEVIATION_BPS",
        env.SOL_PRICE_MAX_DEVIATION_BPS,
        D.maxDeviationBps,
        1_000,
      ),
      refreshMs: boundedInt("SOL_PRICE_REFRESH_MS", env.SOL_PRICE_REFRESH_MS, D.refreshMs, 600_000),
    },
    jupiterApiUrl: env.JUPITER_API_URL?.trim() || JUPITER_API_DEFAULT_URL,
    stonkfunEnabled: env.STONKFUN_MAINNET_ENABLED === "1",
  };
}

// ------------------------------------------------------------------ parsing

/** Satu bacaan harga. `observedAtMs` = waktu harga menurut sumbernya. */
export interface PriceObservation {
  usd: number;
  observedAtMs: number;
}

const positivePrice = z.number().finite().positive();

/** Blok `prices` respons pricing StonkFun → bacaan; melempar bila tidak utuh. */
export function parseStonkFunPrices(prices: unknown): PriceObservation {
  const p = z
    .object({ solUsd: positivePrice, observedAt: z.string().min(1) })
    .passthrough()
    .parse(prices);
  const observedAtMs = Date.parse(p.observedAt);
  if (!Number.isFinite(observedAtMs)) throw new Error("prices.observedAt bukan waktu yang valid");
  return { usd: p.solUsd, observedAtMs };
}

/** Blok `prices` → harga quote (`quoteUsd`); melempar bila tidak utuh. */
export function parseStonkFunQuotePrice(prices: unknown): PriceObservation {
  const p = z
    .object({ quoteUsd: positivePrice, observedAt: z.string().min(1) })
    .passthrough()
    .parse(prices);
  const observedAtMs = Date.parse(p.observedAt);
  if (!Number.isFinite(observedAtMs)) throw new Error("prices.observedAt bukan waktu yang valid");
  return { usd: p.quoteUsd, observedAtMs };
}

/**
 * Respons Jupiter `GET /price/v3?ids=<mint>` → harga. Field `createdAt` di respons adalah waktu
 * token dibuat, bukan waktu harga, jadi waktu bacaan = saat diterima (Jupiter tidak memberi waktu).
 */
export function parseJupiterPrice(json: unknown, mint: string, nowMs: number): PriceObservation {
  const entry = z.record(z.string(), z.unknown()).parse(json)[mint];
  const { usdPrice } = z.object({ usdPrice: positivePrice }).passthrough().parse(entry);
  return { usd: usdPrice, observedAtMs: nowMs };
}

// ------------------------------------------------------------------ evaluasi (murni)

export type SolPriceIssue =
  | "stonkfun_unreadable"
  | "stonkfun_stale"
  | "stonkfun_future"
  | "jupiter_unreadable"
  | "jupiter_stale"
  | "deviation_too_large";

export interface SolPriceSourceState {
  usd: number | null;
  observedAt: string | null;
  ageSeconds: number | null;
  /** Pesan pembacaan terakhir yang gagal. Hanya untuk log & preflight, tidak dikirim ke publik. */
  error: string | null;
}

export interface SolPriceSnapshot {
  status: "verified" | "unverified";
  /** Harga StonkFun. null kecuali `verified`: tidak ada angka lama yang bisa terpakai. */
  usd: number | null;
  /** Waktu bacaan tertua dari kedua sumber (null kecuali `verified`). */
  observedAt: string | null;
  ageSeconds: number | null;
  deviationBps: number | null;
  issues: SolPriceIssue[];
  sources: { stonkfun: SolPriceSourceState; jupiter: SolPriceSourceState };
  checkedAt: string;
}

export interface SourceReading {
  /** Bacaan terakhir yang berhasil. */
  observation: PriceObservation | null;
  /** Kegagalan pembacaan terakhir; null bila pembacaan terakhir berhasil. */
  error: string | null;
}

export function evaluateSolPrice(
  stonkfun: SourceReading,
  jupiter: SourceReading,
  config: SolPriceConfig,
  nowMs: number,
): SolPriceSnapshot {
  const issues: SolPriceIssue[] = [];
  const state = (r: SourceReading, name: "stonkfun" | "jupiter"): SolPriceSourceState => {
    const o = r.observation;
    if (!o) {
      issues.push(`${name}_unreadable`);
      return { usd: null, observedAt: null, ageSeconds: null, error: r.error };
    }
    const ageSeconds = Math.floor((nowMs - o.observedAtMs) / 1000);
    if (ageSeconds < -config.maxFutureSkewSeconds && name === "stonkfun") {
      issues.push("stonkfun_future");
    } else if (ageSeconds > config.maxAgeSeconds) {
      issues.push(r.error ? `${name}_unreadable` : `${name}_stale`);
    }
    return {
      usd: o.usd,
      observedAt: new Date(o.observedAtMs).toISOString(),
      ageSeconds: Math.max(ageSeconds, 0),
      error: r.error,
    };
  };
  const a = state(stonkfun, "stonkfun");
  const b = state(jupiter, "jupiter");

  let deviationBps: number | null = null;
  if (a.usd !== null && b.usd !== null) {
    deviationBps = Math.round((Math.abs(a.usd - b.usd) / Math.min(a.usd, b.usd)) * 10_000);
    if (deviationBps > config.maxDeviationBps) issues.push("deviation_too_large");
  }

  const verified = issues.length === 0;
  const oldest = verified
    ? Math.min(stonkfun.observation!.observedAtMs, jupiter.observation!.observedAtMs)
    : null;
  return {
    status: verified ? "verified" : "unverified",
    usd: verified ? a.usd : null,
    observedAt: oldest === null ? null : new Date(oldest).toISOString(),
    ageSeconds: verified ? Math.max(a.ageSeconds!, b.ageSeconds!) : null,
    deviationBps,
    issues,
    sources: { stonkfun: a, jupiter: b },
    checkedAt: new Date(nowMs).toISOString(),
  };
}

// ------------------------------------------------------------------ pembacaan & cache

const shortError = (err: unknown) => ((err as Error)?.message ?? String(err)).slice(0, 200);

export interface JupiterPriceOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}

/** Jupiter Price API, hanya GET. Sesudah 429 tidak ada request sampai `Retry-After` lewat. */
export class JupiterPriceSource {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private blockedUntil = 0;

  constructor(opts: JupiterPriceOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? JUPITER_API_DEFAULT_URL).replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = opts.timeoutMs ?? SOL_PRICE_CONFIG.jupiterTimeoutMs;
    this.now = opts.now ?? Date.now;
  }

  async read(mint: string = WSOL_MINT): Promise<PriceObservation> {
    if (this.now() < this.blockedUntil) throw new Error("Jupiter rate limit: menunggu Retry-After");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/price/v3?ids=${encodeURIComponent(mint)}`, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: ctrl.signal,
      });
      const body = await res.text();
      if (res.status === 429) {
        const seconds = Number(res.headers.get("retry-after"));
        this.blockedUntil = this.now() + (seconds > 0 ? seconds * 1000 : 60_000);
      }
      if (res.status !== 200) throw new Error(`Jupiter HTTP ${res.status}`);
      return parseJupiterPrice(JSON.parse(body), mint, this.now());
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Jumlah id per request Jupiter. */
const JUPITER_MAX_IDS = 50;

/**
 * Jupiter untuk banyak quote: permintaan dalam jeda singkat digabung jadi satu request, karena batas
 * rate Jupiter ketat (BUILD_PLAN §7n). Mint yang tidak ada di respons gagal sendiri, bukan semuanya.
 */
export class JupiterPriceBatch {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly delayMs: number;
  private blockedUntil = 0;
  private pending = new Map<string, Array<(r: PriceObservation | Error) => void>>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: JupiterPriceOptions & { delayMs?: number } = {}) {
    this.baseUrl = (opts.baseUrl ?? JUPITER_API_DEFAULT_URL).replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = opts.timeoutMs ?? SOL_PRICE_CONFIG.jupiterTimeoutMs;
    this.now = opts.now ?? Date.now;
    this.delayMs = opts.delayMs ?? 250;
  }

  read(mint: string): Promise<PriceObservation> {
    return new Promise((resolve, reject) => {
      const waiters = this.pending.get(mint) ?? [];
      waiters.push((r) => (r instanceof Error ? reject(r) : resolve(r)));
      this.pending.set(mint, waiters);
      this.timer ??= setTimeout(() => void this.flush(), this.delayMs);
    });
  }

  private async flush() {
    this.timer = null;
    const batch = this.pending;
    this.pending = new Map();
    const mints = [...batch.keys()];
    for (let i = 0; i < mints.length; i += JUPITER_MAX_IDS) {
      const ids = mints.slice(i, i + JUPITER_MAX_IDS);
      let json: unknown = null;
      let failure: Error | null = null;
      try {
        json = await this.fetchIds(ids);
      } catch (err) {
        failure = err instanceof Error ? err : new Error(String(err));
      }
      for (const mint of ids) {
        let result: PriceObservation | Error;
        try {
          if (failure) throw failure;
          result = parseJupiterPrice(json, mint, this.now());
        } catch (err) {
          result = err instanceof Error ? err : new Error(String(err));
        }
        for (const done of batch.get(mint) ?? []) done(result);
      }
    }
  }

  private async fetchIds(ids: string[]): Promise<unknown> {
    if (this.now() < this.blockedUntil) throw new Error("Jupiter rate limit: menunggu Retry-After");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/price/v3?ids=${ids.join(",")}`, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: ctrl.signal,
      });
      const body = await res.text();
      if (res.status === 429) {
        const seconds = Number(res.headers.get("retry-after"));
        this.blockedUntil = this.now() + (seconds > 0 ? seconds * 1000 : 60_000);
      }
      if (res.status !== 200) throw new Error(`Jupiter HTTP ${res.status}`);
      return JSON.parse(body);
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface SolPriceReader {
  /** Status saat ini tanpa menunggu jaringan; pembacaan yang jatuh tempo berjalan di belakang. */
  current(): SolPriceSnapshot;
  /** Menunggu pembacaan yang jatuh tempo, lalu memberi status. Tidak pernah melempar. */
  read(): Promise<SolPriceSnapshot>;
}

export interface SolPriceOracleOptions {
  stonkfun: () => Promise<PriceObservation>;
  jupiter: () => Promise<PriceObservation>;
  config?: SolPriceConfig;
  now?: () => number;
}

/**
 * Cache satu proses: paling banyak satu pembacaan tiap `refreshMs`, berapa pun jumlah pair dan
 * request. Umur dinilai ulang tiap kali diminta, jadi bacaan yang menua tidak terus dianggap benar.
 */
export class SolPriceOracle implements SolPriceReader {
  private readonly config: SolPriceConfig;
  private readonly now: () => number;
  private stonkfun: SourceReading = { observation: null, error: "belum dibaca" };
  private jupiter: SourceReading = { observation: null, error: "belum dibaca" };
  private lastReadAt = Number.NEGATIVE_INFINITY;
  private inflight: Promise<void> | null = null;

  constructor(private readonly opts: SolPriceOracleOptions) {
    this.config = opts.config ?? SOL_PRICE_CONFIG;
    this.now = opts.now ?? Date.now;
  }

  private refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    if (this.now() - this.lastReadAt < this.config.refreshMs) return Promise.resolve();
    this.lastReadAt = this.now();
    const load = async (read: () => Promise<PriceObservation>, prev: SourceReading) => {
      try {
        return { observation: await read(), error: null };
      } catch (err) {
        return { observation: prev.observation, error: shortError(err) };
      }
    };
    this.inflight = (async () => {
      const [a, b] = await Promise.all([
        load(this.opts.stonkfun, this.stonkfun),
        load(this.opts.jupiter, this.jupiter),
      ]);
      this.stonkfun = a;
      this.jupiter = b;
      this.inflight = null;
    })();
    return this.inflight;
  }

  private evaluate() {
    return evaluateSolPrice(this.stonkfun, this.jupiter, this.config, this.now());
  }

  current(): SolPriceSnapshot {
    void this.refresh();
    return this.evaluate();
  }

  async read(): Promise<SolPriceSnapshot> {
    await this.refresh();
    return this.evaluate();
  }
}

/** Jumlah quote yang harganya dipantau bersamaan; lewat dari ini yang paling lama tak diminta dilepas. */
const QUOTE_PRICE_MAX_MINTS = 64;

export interface QuotePriceBookOptions {
  stonkfun: (mint: string) => Promise<PriceObservation>;
  jupiter: (mint: string) => Promise<PriceObservation>;
  config?: SolPriceConfig;
  now?: () => number;
  maxMints?: number;
}

/**
 * Harga USD per quote: aturan yang sama dengan harga SOL (dua sumber wajib terbaca, batas umur &
 * selisih) lewat satu `SolPriceOracle` per mint. Hanya mint yang diminta yang dibaca.
 *
 * Quote xStocks memakai `ScaledUiAmount`: StonkFun melaporkan harga per unit mentah, Jupiter per unit
 * tampilan, jadi keduanya berselisih sebesar pengali penerbit. Selisih di atas batas berarti `n/a`.
 */
export class QuotePriceBook {
  private readonly oracles = new Map<string, SolPriceOracle>();
  private readonly maxMints: number;

  constructor(private readonly opts: QuotePriceBookOptions) {
    this.maxMints = opts.maxMints ?? QUOTE_PRICE_MAX_MINTS;
  }

  private oracle(mint: string): SolPriceOracle {
    let o = this.oracles.get(mint);
    if (o) {
      this.oracles.delete(mint);
    } else {
      o = new SolPriceOracle({
        stonkfun: () => this.opts.stonkfun(mint),
        jupiter: () => this.opts.jupiter(mint),
        ...(this.opts.config ? { config: this.opts.config } : {}),
        ...(this.opts.now ? { now: this.opts.now } : {}),
      });
      if (this.oracles.size >= this.maxMints) {
        const oldest = this.oracles.keys().next().value;
        if (oldest !== undefined) this.oracles.delete(oldest);
      }
    }
    this.oracles.set(mint, o); // Map menjaga urutan: yang terakhir diminta di ujung
    return o;
  }

  current(mint: string): SolPriceSnapshot {
    return this.oracle(mint).current();
  }

  read(mint: string): Promise<SolPriceSnapshot> {
    return this.oracle(mint).read();
  }
}

/**
 * Alert harga (monitor Telegram & /api/health/status). `warn`: tidak ada dana bergerak, hanya USD
 * `n/a` dan deployment reserve tertahan. null = status harga sendiri tidak terbaca.
 */
export function solPriceAlert(p: SolPriceSnapshot | null) {
  const why = p ? p.issues.join(", ") : "pembacaan gagal";
  return {
    level: "warn" as const,
    code: "sol_price_unverified",
    message: `harga SOL/USD tidak terverifikasi (${why}): USD tampil n/a, deployment reserve ditahan`,
  };
}

// ------------------------------------------------------------------ konversi USD

/**
 * Cara angka native menjadi setara USD pada satu saat:
 *  - `assumed` (devnet): harga asumsi pair, selalu berlabel MOCK;
 *  - `live` (mainnet, harga SOL terverifikasi): per quote lewat `QuotePriceBook`; selalu estimasi;
 *  - `none` (mainnet, harga tidak terverifikasi): tidak ada USD sama sekali.
 */
export interface UsdRates {
  kind: "assumed" | "live" | "none";
  /**
   * Harga USD per unit quote mint. `NaN` di `live` = quote ini tidak terverifikasi: NaN ikut menular
   * ke hasil kali & jumlah, lalu `usdStat` menampilkan `n/a`, bukan angka yang kurang atau $0.
   */
  rateFor(mint: string): number;
  /** Waktu harga (`live`). */
  observedAt: string | null;
}

export function usdRatesFor(
  cluster: SolanaCluster,
  snapshot: SolPriceSnapshot | null,
  quotes?: Pick<QuotePriceBook, "current"> | null,
): UsdRates {
  if (cluster !== "mainnet-beta") {
    return {
      kind: "assumed",
      rateFor: (mint) => pairForMint(cluster, mint)?.assumedPriceUsd ?? 0,
      observedAt: null,
    };
  }
  if (snapshot?.status !== "verified" || snapshot.usd === null) {
    return { kind: "none", rateFor: () => 0, observedAt: null };
  }
  const usd = snapshot.usd;
  return {
    kind: "live",
    rateFor: (mint) => {
      if (mint === WSOL_MINT) return usd;
      const q = quotes?.current(mint);
      return q?.status === "verified" && q.usd !== null ? q.usd : Number.NaN;
    },
    observedAt: snapshot.observedAt,
  };
}
