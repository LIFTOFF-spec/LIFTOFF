import {
  assertValidReserveConfig,
  ECONOMIC_CONFIG,
  INDEXER_CONFIG,
  parsePerQuoteEnv,
  type IndexerConfig,
  LAUNCH_ENGINE,
  MONITOR_CONFIG,
  platformFor,
  RESERVE_CONFIG,
  RESERVE_WORKER_CONFIG,
  solPriceSettingsFrom,
  type LaunchEngineConfig,
  type LaunchSendMode,
  type FeeIntakeMode,
  type PlatformAddresses,
  type SolanaCluster,
  type SolPriceSettings,
} from "@liftoff/shared";
import { assertSendModeAllowed, resolveCluster, rpcUrlFor } from "@liftoff/solana";
import type { EconomicWorkerSettings } from "./economic/ports";
import type { ReserveWorkerSettings } from "./economic/reserve";

export interface WorkerConfig {
  cluster: SolanaCluster;
  platform: PlatformAddresses;
  redisUrl: string;
  rpcUrl: string;
  /** F8: RPC cadangan (failover baca). Bisa memuat API key: jangan di-log. */
  rpcBackupUrl: string | null;
  signerUrl: string;
  /** Token internal worker → signer. Tidak pernah di-log. */
  signerAuthToken: string;
  jitoBlockEngineUrl: string | null;
  /** Basis URL publik API untuk URI metadata token. */
  publicApiUrl: string;
  engine: LaunchEngineConfig;
  concurrency: number;
  /** LAUNCH_DEVNET_FUND_RAISING_RAW: target graduation kecil untuk uji devnet. null = normal. */
  devnetFundRaisingOverride: bigint | null;
}

/**
 * Token worker → signer (F12, Tahap 10): token khusus cakupan (SIGNER_LAUNCH_TOKEN /
 * SIGNER_ECONOMIC_TOKEN), fallback SIGNER_AUTH_TOKEN lama (cakupan semua tujuan).
 */
export function signerTokenFor(
  scope: "launch" | "economic",
  env: NodeJS.ProcessEnv = process.env,
): string {
  const name = scope === "launch" ? "SIGNER_LAUNCH_TOKEN" : "SIGNER_ECONOMIC_TOKEN";
  const token = env[name]?.trim() || env.SIGNER_AUTH_TOKEN?.trim() || "";
  if (token.length < 32) {
    throw new Error(`${name} (atau SIGNER_AUTH_TOKEN lama) wajib, minimal 32 karakter`);
  }
  return token;
}

/** F8: RPC cadangan untuk failover baca (RPC_BACKUP_URL). Bisa memuat API key: jangan di-log. */
function backupRpc(env: NodeJS.ProcessEnv): string | null {
  return env.RPC_BACKUP_URL?.trim() || null;
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`env bukan bilangan bulat >= 0: ${value}`);
  return n;
}

/** Override target graduation: hanya devnet (uji graduation murah), selain itu ditolak saat start. */
function devnetOverride(value: string | undefined, cluster: SolanaCluster): bigint | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (cluster !== "devnet") throw new Error("LAUNCH_DEVNET_FUND_RAISING_RAW hanya boleh di devnet");
  if (!/^[1-9][0-9]*$/.test(raw))
    throw new Error("LAUNCH_DEVNET_FUND_RAISING_RAW harus bilangan bulat > 0");
  return BigInt(raw);
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const cluster = resolveCluster(env);
  const devnetFundRaisingOverride = devnetOverride(env.LAUNCH_DEVNET_FUND_RAISING_RAW, cluster);
  const mode = (env.LAUNCH_SEND_MODE?.trim() || LAUNCH_ENGINE.sendMode) as LaunchSendMode;
  if (mode !== "rpc" && mode !== "jito") throw new Error("LAUNCH_SEND_MODE harus rpc | jito");
  assertSendModeAllowed(mode, cluster);
  const jitoBlockEngineUrl = env.JITO_BLOCK_ENGINE_URL?.trim() || null;
  if (mode === "jito" && !jitoBlockEngineUrl)
    throw new Error("LAUNCH_SEND_MODE=jito butuh JITO_BLOCK_ENGINE_URL");
  const signerAuthToken = signerTokenFor("launch", env);
  return {
    cluster,
    platform: platformFor(cluster, env),
    rpcBackupUrl: backupRpc(env),
    redisUrl: env.REDIS_URL?.trim() || "redis://localhost:6379",
    rpcUrl: rpcUrlFor(cluster, env.RPC_URL),
    signerUrl: env.SIGNER_URL?.trim() || "http://127.0.0.1:4100",
    signerAuthToken,
    jitoBlockEngineUrl,
    publicApiUrl: (env.PUBLIC_API_URL?.trim() || "http://localhost:4000").replace(/\/$/, ""),
    engine: {
      ...LAUNCH_ENGINE,
      sendMode: mode,
      maxSubmissions: int(env.LAUNCH_MAX_SUBMISSIONS, LAUNCH_ENGINE.maxSubmissions),
      jitoTipLamports: int(env.JITO_TIP_LAMPORTS, LAUNCH_ENGINE.jitoTipLamports),
    },
    concurrency: int(env.LAUNCH_WORKER_CONCURRENCY, 2),
    devnetFundRaisingOverride,
  };
}

export interface IndexerWorkerConfig {
  cluster: SolanaCluster;
  platform: PlatformAddresses;
  /** INDEXER_RPC_URL (mis. Helius, opsional) → fallback RPC_URL. Bisa memuat API key: jangan di-log. */
  rpcUrl: string;
  rpcBackupUrl: string | null;
  indexer: IndexerConfig;
}

/** Config indexer (Tahap 6). Tidak butuh signer: indexer hanya membaca chain & menulis DB. */
export function loadIndexerConfig(env: NodeJS.ProcessEnv = process.env): IndexerWorkerConfig {
  const cluster = resolveCluster(env);
  return {
    cluster,
    platform: platformFor(cluster, env),
    rpcUrl: rpcUrlFor(cluster, env.INDEXER_RPC_URL, env.RPC_URL),
    rpcBackupUrl: backupRpc(env),
    indexer: {
      ...INDEXER_CONFIG,
      pollIntervalMs: int(env.INDEXER_POLL_INTERVAL_MS, INDEXER_CONFIG.pollIntervalMs),
      holdersRefreshMs: int(env.INDEXER_HOLDERS_REFRESH_MS, INDEXER_CONFIG.holdersRefreshMs),
      rpcMinIntervalMs: int(env.INDEXER_RPC_MIN_INTERVAL_MS, INDEXER_CONFIG.rpcMinIntervalMs),
      maxTransactionsPerCycle: int(
        env.INDEXER_MAX_TX_PER_CYCLE,
        INDEXER_CONFIG.maxTransactionsPerCycle,
      ),
    },
  };
}

export interface EconomicWorkerConfig {
  cluster: SolanaCluster;
  platform: PlatformAddresses;
  rpcUrl: string;
  rpcBackupUrl: string | null;
  signerUrl: string;
  /** Token internal worker → signer. Tidak pernah di-log. */
  signerAuthToken: string;
  economic: EconomicWorkerSettings;
  reserve: ReserveWorkerSettings;
  solPrice: SolPriceSettings;
}

/**
 * Config economic engine (Tahap 7). Interval claim/buyback & threshold di config
 * (ECONOMIC_CONFIG); override env hanya untuk uji lokal (mis. BUYBACK_MIN_RAW=sol=5000).
 */
export function loadEconomicConfig(env: NodeJS.ProcessEnv = process.env): EconomicWorkerConfig {
  const cluster = resolveCluster(env);
  const signerAuthToken = signerTokenFor("economic", env);
  // Default cpmm di semua cluster: jalur buyback Jupiter belum dibuat (engine akan melewatinya).
  const route = (env.TRADE_GRADUATED_ROUTE?.trim() || "cpmm") as "cpmm" | "jupiter";
  if (route !== "cpmm" && route !== "jupiter")
    throw new Error("TRADE_GRADUATED_ROUTE harus cpmm | jupiter");
  const E = ECONOMIC_CONFIG;
  const slippageBps = int(env.BUYBACK_SLIPPAGE_BPS, E.slippageBps);
  if (slippageBps <= 0 || slippageBps > 2_000)
    throw new Error("BUYBACK_SLIPPAGE_BPS harus 1..2000");
  return {
    cluster,
    platform: platformFor(cluster, env),
    rpcUrl: rpcUrlFor(cluster, env.RPC_URL),
    rpcBackupUrl: backupRpc(env),
    signerUrl: env.SIGNER_URL?.trim() || "http://127.0.0.1:4100",
    signerAuthToken,
    economic: {
      ...E,
      claimIntervalMs: int(env.FEE_CLAIM_INTERVAL_MS, E.claimIntervalMs),
      buybackIntervalMs: int(env.BUYBACK_INTERVAL_MS, E.buybackIntervalMs),
      reconcileGraceMs: int(env.FEE_RECONCILE_GRACE_MS, E.reconcileGraceMs),
      minClaimRaw: parsePerQuoteEnv(env.FEE_CLAIM_MIN_RAW, E.minClaimRaw),
      minBuybackRaw: parsePerQuoteEnv(env.BUYBACK_MIN_RAW, E.minBuybackRaw),
      maxBuybackRawPerTx: parsePerQuoteEnv(env.BUYBACK_MAX_RAW_PER_TX, E.maxBuybackRawPerTx),
      slippageBps,
      maxPriceImpactBps: int(env.BUYBACK_MAX_PRICE_IMPACT_BPS, E.maxPriceImpactBps),
      computeUnitPriceMicroLamports: int(
        env.ECONOMIC_CU_PRICE_MICROLAMPORTS,
        E.computeUnitPriceMicroLamports,
      ),
      retryBackoffMs: int(env.ECONOMIC_RETRY_BACKOFF_MS, E.retryBackoffMs),
      graduatedRoute: route,
      // Devnet (emulasi) = claim; StonkFun asli = creator fee diteruskan otomatis (forwarded).
      feeIntake: feeIntakeFrom(env.FEE_INTAKE, cluster),
      forwarders: (env.STONKFUN_FORWARDERS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      feeSpendingEnabled: feeSpendingFrom(
        env.FEE_SPENDING_ENABLED,
        feeIntakeFrom(env.FEE_INTAKE, cluster),
      ),
      confirmWaitMs: int(env.ECONOMIC_CONFIRM_WAIT_MS, 60_000),
      confirmPollMs: 2_000,
    },
    reserve: loadReserveSettings(env),
    solPrice: solPriceSettingsFrom(env),
  };
}

/** Strategi fee intake: env FEE_INTAKE (claim|forwarded), default mengikuti cluster. */
export function feeIntakeFrom(value: string | undefined, cluster: SolanaCluster): FeeIntakeMode {
  const v = value?.trim();
  if (!v) return cluster === "devnet" ? "claim" : "forwarded";
  if (v !== "claim" && v !== "forwarded") throw new Error("FEE_INTAKE harus claim atau forwarded");
  return v;
}

/**
 * Buyback & reserve boleh membelanjakan fee? Env FEE_SPENDING_ENABLED (0|1). Default: hidup untuk
 * `claim`; mati untuk `forwarded` sampai penerusan fee StonkFun terbukti dan langkah wrap SOL ada.
 */
export function feeSpendingFrom(value: string | undefined, intake: FeeIntakeMode): boolean {
  const v = value?.trim();
  if (!v) return intake === "claim";
  if (v !== "0" && v !== "1") throw new Error("FEE_SPENDING_ENABLED harus 0 atau 1");
  return v === "1";
}

/**
 * Config Conviction Reserve Worker (Tahap 8). Default = RESERVE_CONFIG (nilai Spec §12). Override
 * env HANYA untuk .env uji lokal: RESERVE_MIN_BALANCE_TO_DEPLOY_USD menurunkan threshold $250
 * supaya deployment devnet bisa dibuktikan dengan reserve kecil; parameter lain tetap nilai Spec.
 */
export function loadReserveSettings(env: NodeJS.ProcessEnv = process.env): ReserveWorkerSettings {
  const config = {
    ...RESERVE_CONFIG,
    minBalanceToDeployUsd: int(
      env.RESERVE_MIN_BALANCE_TO_DEPLOY_USD,
      RESERVE_CONFIG.minBalanceToDeployUsd,
    ),
  };
  assertValidReserveConfig(config);
  return {
    config,
    intervalMs: int(env.RESERVE_INTERVAL_MS, RESERVE_WORKER_CONFIG.intervalMs),
    minFundRaw: parsePerQuoteEnv(env.RESERVE_FUND_MIN_RAW, { ...RESERVE_WORKER_CONFIG.minFundRaw }),
  };
}

export interface MonitorConfig {
  cluster: SolanaCluster;
  platform: PlatformAddresses;
  rpcUrl: string;
  rpcBackupUrl: string | null;
  redisUrl: string;
  /** Kosong = signer tidak diperiksa. */
  signerUrl: string | null;
  intervalMs: number;
  repeatAlertMs: number;
  /** Notifikasi eksternal opsional; semua kosong = hanya log `ALERT:`. Tidak pernah di-log. */
  telegram: { botToken: string; chatId: string } | null;
  webhookUrl: string | null;
  solPrice: SolPriceSettings;
}

/** Config proses monitor (Tahap 9). Tidak butuh SIGNER_AUTH_TOKEN: hanya membaca /health. */
export function loadMonitorConfig(env: NodeJS.ProcessEnv = process.env): MonitorConfig {
  const cluster = resolveCluster(env);
  const botToken = env.ALERT_TELEGRAM_BOT_TOKEN?.trim() ?? "";
  const chatId = env.ALERT_TELEGRAM_CHAT_ID?.trim() ?? "";
  if (!!botToken !== !!chatId) {
    throw new Error("ALERT_TELEGRAM_BOT_TOKEN dan ALERT_TELEGRAM_CHAT_ID harus diisi berdua");
  }
  const webhookUrl = env.ALERT_WEBHOOK_URL?.trim() || null;
  if (
    webhookUrl &&
    !/^https:\/\//.test(webhookUrl) &&
    !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(webhookUrl)
  ) {
    throw new Error("ALERT_WEBHOOK_URL harus https:// (atau http://localhost untuk uji)");
  }
  return {
    cluster,
    platform: platformFor(cluster, env),
    rpcUrl: rpcUrlFor(cluster, env.RPC_URL),
    rpcBackupUrl: backupRpc(env),
    redisUrl: env.REDIS_URL?.trim() || "redis://localhost:6379",
    signerUrl: env.SIGNER_URL?.trim() || null,
    intervalMs: int(env.MONITOR_INTERVAL_MS, MONITOR_CONFIG.intervalMs),
    repeatAlertMs: int(env.ALERT_REPEAT_MS, MONITOR_CONFIG.repeatAlertMs),
    telegram: botToken ? { botToken, chatId } : null,
    webhookUrl,
    solPrice: solPriceSettingsFrom(env),
  };
}
