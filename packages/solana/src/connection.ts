import { GENESIS_HASH, type SolanaCluster } from "@liftoff/shared";
import { Connection, type Commitment } from "@solana/web3.js";

export interface ConnectionOptions {
  commitment?: Commitment;
  /** Batas waktu tiap request RPC. Timeout → error, dan pemanggil memutuskan retry. */
  timeoutMs?: number;
  /** Retry untuk HTTP 429 (RPC publik devnet membatasi laju dengan ketat). */
  maxRateLimitRetries?: number;
  /**
   * F8 (Tahap 10): RPC cadangan (`RPC_BACKUP_URL`). Request yang gagal di RPC utama (timeout,
   * jaringan, 5xx, 429 setelah retry) diulang SEKALI ke cadangan. Bisa memuat API key: jangan di-log.
   */
  backupUrl?: string | null | undefined;
  /**
   * Cluster aktif (hasil `resolveCluster`). Tanpa ini RPC mainnet selalu ditolak: lupa mengisi
   * berarti gagal, bukan diam-diam tersambung ke uang asli.
   */
  cluster?: SolanaCluster;
}

/** Error RPC yang aman di-retry (timeout, jaringan, 429/5xx). */
export class RpcUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RpcUnavailableError";
  }
}

/** Nama URL harus sejalan dengan cluster (cek cepat; cek pasti = hash genesis, lihat bawah). */
function assertUrlMatchesCluster(url: string, cluster: SolanaCluster | undefined) {
  if (cluster === "mainnet-beta") {
    if (/devnet|testnet/i.test(url)) {
      throw new Error("RPC_URL mengarah ke devnet/testnet padahal cluster mainnet-beta; ditolak.");
    }
  } else if (/mainnet/i.test(url)) {
    throw new Error(`RPC_URL mengarah ke mainnet padahal cluster ${cluster ?? "devnet"}; ditolak.`);
  }
}

const DEVNET_PUBLIC_RPC = "https://api.devnet.solana.com";

/**
 * URL RPC pertama yang terisi dari `candidates`. Hanya devnet yang punya default: di cluster lain
 * RPC wajib diisi agar tidak pernah jatuh ke RPC devnet tanpa disadari.
 */
export function rpcUrlFor(
  cluster: SolanaCluster,
  ...candidates: Array<string | null | undefined>
): string {
  const url = candidates.map((c) => c?.trim()).find(Boolean);
  if (url) return url;
  if (cluster === "devnet") return DEVNET_PUBLIC_RPC;
  throw new Error(`RPC_URL wajib diisi untuk cluster ${cluster}`);
}

/** Hasil pemeriksaan satu RPC terhadap cluster yang diharapkan. */
export type RpcClusterCheck =
  | { ok: true; genesis: string }
  | { ok: false; reason: "wrong_cluster"; genesis: string }
  | { ok: false; reason: "unreachable"; message: string };

/** Mencocokkan hash genesis RPC dengan cluster (hanya baca). URL tidak dimasukkan ke pesan. */
export async function checkRpcCluster(
  rpcUrl: string,
  cluster: SolanaCluster,
  timeoutMs = 15_000,
): Promise<RpcClusterCheck> {
  try {
    const conn = new Connection(rpcUrl, {
      commitment: "confirmed",
      fetch: fetcher(timeoutMs, 1) as typeof fetch,
      disableRetryOnRateLimit: true,
    });
    const genesis = await conn.getGenesisHash();
    return genesis === GENESIS_HASH[cluster]
      ? { ok: true, genesis }
      : { ok: false, reason: "wrong_cluster", genesis };
  } catch (err) {
    return { ok: false, reason: "unreachable", message: (err as Error).name };
  }
}

/**
 * Pengaman saat start: di mainnet RPC utama WAJIB menjawab hash genesis mainnet, dan RPC cadangan
 * yang menjawab cluster lain ditolak. Di cluster lain, hanya RPC yang ternyata mainnet yang ditolak
 * (validator lokal punya genesis sendiri; RPC yang sedang gangguan tidak menghalangi devnet).
 */
export async function assertRpcCluster(
  cluster: SolanaCluster,
  rpcUrl: string,
  backupUrl?: string | null,
): Promise<void> {
  for (const [label, url] of [
    ["RPC_URL", rpcUrl],
    ["RPC_BACKUP_URL", backupUrl],
  ] as const) {
    if (!url) continue;
    const r = await checkRpcCluster(url, cluster);
    if (cluster === "mainnet-beta") {
      if (r.ok) continue;
      if (r.reason === "wrong_cluster") {
        throw new Error(`${label} bukan RPC mainnet-beta (genesis ${r.genesis})`);
      }
      // Cadangan yang sedang gangguan tidak menghentikan layanan; utama wajib menjawab.
      if (label === "RPC_URL") throw new Error(`RPC_URL tidak menjawab (${r.message})`);
    } else if (
      !r.ok &&
      r.reason === "wrong_cluster" &&
      r.genesis === GENESIS_HASH["mainnet-beta"]
    ) {
      throw new Error(`${label} adalah RPC mainnet padahal cluster ${cluster}`);
    }
  }
}

/** Fetch dengan timeout + backoff 429 ke satu URL. */
function fetcher(timeoutMs: number, maxRetries: number) {
  return async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        throw new RpcUnavailableError(`RPC tidak merespons (${(err as Error).name})`, {
          cause: err,
        });
      }
      if (res.status !== 429 || attempt >= maxRetries) return res;
      await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, 8_000)));
    }
  };
}

/**
 * Fetch failover (F8): utama dulu; bila utama tidak tersedia (error jaringan/timeout, 5xx, 429)
 * request yang SAMA dikirim ke cadangan. Body JSON-RPC dibaca ulang dari `init`, jadi aman diulang.
 */
export function failoverFetch(
  primary: typeof fetch,
  backup: typeof fetch,
  backupUrl: string,
): typeof fetch {
  return async (input, init) => {
    try {
      const res = await primary(input, init);
      if (res.status < 500 && res.status !== 429) return res;
    } catch (err) {
      if (!(err instanceof RpcUnavailableError)) throw err;
    }
    return backup(backupUrl, init);
  };
}

/**
 * Connection dengan timeout per request, backoff untuk 429, dan (opsional) failover baca ke RPC
 * cadangan. RPC mainnet hanya diterima bila `options.cluster` = mainnet-beta (Aturan #1).
 */
export function createConnection(rpcUrl: string, options: ConnectionOptions = {}): Connection {
  assertUrlMatchesCluster(rpcUrl, options.cluster);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxRetries = options.maxRateLimitRetries ?? 6;
  const backupUrl = options.backupUrl?.trim() || null;
  if (backupUrl) assertUrlMatchesCluster(backupUrl, options.cluster);
  // Dengan cadangan: retry 429 di utama dipersingkat, lalu pindah ke cadangan.
  const primary = fetcher(timeoutMs, backupUrl ? 1 : maxRetries) as typeof fetch;
  const fetchFn = backupUrl
    ? failoverFetch(primary, fetcher(timeoutMs, maxRetries) as typeof fetch, backupUrl)
    : primary;
  return new Connection(rpcUrl, {
    commitment: options.commitment ?? "confirmed",
    fetch: fetchFn,
    disableRetryOnRateLimit: true,
  });
}
