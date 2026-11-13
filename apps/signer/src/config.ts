import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LAUNCH_ENGINE,
  parsePerQuoteEnv,
  platformFor,
  SIGNER_POLICY,
  type PlatformAddresses,
  type SignerPolicyConfig,
  type SignPurpose,
  type SolanaCluster,
} from "@liftoff/shared";
import { resolveCluster, rpcUrlFor } from "@liftoff/solana";

/**
 * Cakupan token signer (F12, Tahap 10). Worker launch hanya boleh meminta tujuan launch, worker
 * economic hanya tujuan ekonomi/reserve. `all` = SIGNER_AUTH_TOKEN lama (kompatibilitas).
 */
export type SignerScope = "launch" | "economic" | "all";

export const SCOPE_PURPOSES: Record<Exclude<SignerScope, "all">, readonly SignPurpose[]> = {
  launch: ["launch", "deposit_refund"],
  economic: ["fee_claim", "buyback", "burn", "reserve_fund", "reserve_deploy"],
};

export function scopeAllows(scope: SignerScope, purpose: SignPurpose | "mint"): boolean {
  if (scope === "all") return true;
  if (purpose === "mint") return scope === "launch";
  return SCOPE_PURPOSES[scope].includes(purpose);
}

export interface SignerToken {
  token: string;
  scope: SignerScope;
}

export interface SignerConfig {
  cluster: SolanaCluster;
  platform: PlatformAddresses;
  /** Path file keypair master wallet; WAJIB di luar repo. */
  keypairPath: string;
  /** Token Bearer yang diterima beserta cakupannya (F12). */
  authTokens: SignerToken[];
  /** Default 127.0.0.1: signer tidak boleh terekspos ke jaringan publik. */
  host: string;
  port: number;
  rpcUrl: string;
  /** F8: RPC cadangan (failover baca + cek silang aksi besar). null = tidak dipakai. */
  backupRpcUrl: string | null;
  policy: SignerPolicyConfig;
  /** Tip Jito maksimum yang boleh ada di transaksi launch (lamport). */
  maxTipLamports: number;
  /** SIGNER_PAUSED=1 → pause keras dari env (tidak bisa di-resume lewat API/CLI). */
  envPaused: boolean;
}

/**
 * Root repo = folder induk terdekat yang berisi pnpm-workspace.yaml. Tidak bisa dihitung dari
 * kedalaman folder: hasil bundle (`/app/dist/chunk-*.js`) letaknya beda dengan `src/`, dan
 * `../../../` dari situ menjadi `/` sehingga semua path dianggap "di dalam repo". Di image Docker
 * tidak ada file workspace → root = folder aplikasi (induk `dist/`, yaitu `/app`).
 */
function findRepoRoot(from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    if (dirname(dir) === dir) return dirname(from);
  }
}

export const REPO_ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`env bukan bilangan bulat >= 0: ${value}`);
  return n;
}

function bps(name: string, value: string | undefined, fallback: number): number {
  const n = int(value, fallback);
  if (n <= 0 || n > 2_000) throw new Error(`${name} harus 1..2000`);
  return n;
}

export function isInsideRepo(path: string, repoRoot = REPO_ROOT): boolean {
  const rel = relative(resolve(repoRoot), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Token signer dari env (F12):
 *  - SIGNER_LAUNCH_TOKEN   → cakupan launch (launch, deposit_refund, derive mint);
 *  - SIGNER_ECONOMIC_TOKEN → cakupan economic (claim, buyback, burn, reserve_fund/deploy);
 *  - SIGNER_AUTH_TOKEN     → cakupan semua (lama). Boleh dikosongkan bila dua token di atas diisi.
 * Semua minimal 32 karakter dan harus berbeda satu sama lain.
 */
export function loadSignerTokens(env: NodeJS.ProcessEnv): SignerToken[] {
  const entries: Array<[string, SignerScope]> = [
    ["SIGNER_LAUNCH_TOKEN", "launch"],
    ["SIGNER_ECONOMIC_TOKEN", "economic"],
    ["SIGNER_AUTH_TOKEN", "all"],
  ];
  const tokens: SignerToken[] = [];
  for (const [name, scope] of entries) {
    const token = env[name]?.trim() ?? "";
    if (!token) continue;
    if (token.length < 32) throw new Error(`${name} minimal 32 karakter`);
    if (tokens.some((t) => t.token === token))
      throw new Error(`${name} harus berbeda dari token lain`);
    tokens.push({ token, scope });
  }
  if (!tokens.length) {
    throw new Error(
      "token signer wajib: SIGNER_LAUNCH_TOKEN + SIGNER_ECONOMIC_TOKEN (atau SIGNER_AUTH_TOKEN lama), minimal 32 karakter",
    );
  }
  return tokens;
}

export function loadSignerConfig(env: NodeJS.ProcessEnv = process.env): SignerConfig {
  const cluster = resolveCluster(env);
  const keypairPath = env.SIGNER_KEYPAIR_PATH?.trim() ?? "";
  if (!keypairPath) throw new Error("SIGNER_KEYPAIR_PATH wajib diisi (file keypair di luar repo)");
  if (isInsideRepo(keypairPath)) {
    throw new Error("SIGNER_KEYPAIR_PATH menunjuk ke dalam repo; keypair wajib di luar repo");
  }
  const P = SIGNER_POLICY;
  return {
    cluster,
    platform: platformFor(cluster, env),
    keypairPath,
    authTokens: loadSignerTokens(env),
    host: env.SIGNER_HOST?.trim() || "127.0.0.1",
    port: int(env.SIGNER_PORT, 4100),
    rpcUrl: rpcUrlFor(cluster, env.RPC_URL),
    backupRpcUrl: env.RPC_BACKUP_URL?.trim() || null,
    policy: {
      maxLamportsPerTx: int(env.SIGNER_MAX_LAMPORTS_PER_TX, P.maxLamportsPerTx),
      maxLamportsPer24h: int(env.SIGNER_MAX_LAMPORTS_PER_24H, P.maxLamportsPer24h),
      maxTxPer24h: int(env.SIGNER_MAX_TX_PER_24H, P.maxTxPer24h),
      maxLamportsPerEconomicTx: int(
        env.SIGNER_MAX_LAMPORTS_PER_ECONOMIC_TX,
        P.maxLamportsPerEconomicTx,
      ),
      maxBuybackSlippageBps: bps(
        "SIGNER_MAX_BUYBACK_SLIPPAGE_BPS",
        env.SIGNER_MAX_BUYBACK_SLIPPAGE_BPS,
        P.maxBuybackSlippageBps,
      ),
      maxReserveSlippageBps: bps(
        "SIGNER_MAX_RESERVE_SLIPPAGE_BPS",
        env.SIGNER_MAX_RESERVE_SLIPPAGE_BPS,
        P.maxReserveSlippageBps,
      ),
      maxAssetOutflowRawPer24h: parsePerQuoteEnv(
        env.SIGNER_MAX_ASSET_OUTFLOW_PER_24H,
        P.maxAssetOutflowRawPer24h,
      ),
      crossCheckMinRaw: parsePerQuoteEnv(env.SIGNER_CROSSCHECK_MIN_RAW, P.crossCheckMinRaw),
      crossCheckToleranceBps: bps(
        "SIGNER_CROSSCHECK_TOLERANCE_BPS",
        env.SIGNER_CROSSCHECK_TOLERANCE_BPS,
        P.crossCheckToleranceBps,
      ),
    },
    maxTipLamports: int(env.JITO_TIP_LAMPORTS, LAUNCH_ENGINE.jitoTipLamports),
    envPaused: env.SIGNER_PAUSED === "1",
  };
}
