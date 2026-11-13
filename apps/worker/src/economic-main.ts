// Economic engine (Tahap 7–8): worker fee-processing (claim + rekonsiliasi), buyback + burn, dan
// Conviction Reserve (kustodi per token, monitoring, deployment likuiditas + burn LP).
// Proses terpisah; TIDAK memegang key: transaksi ditandatangani apps/signer (allowlist + budget
// ledger + simulasi + batas harian). Emergency pause = pause signer (`pnpm --filter @liftoff/signer pause`).
//   pnpm --filter @liftoff/worker economic            # loop sesuai interval config
//   pnpm --filter @liftoff/worker economic --once     # satu siklus fee, buyback, reserve, lalu keluar
//   pnpm --filter @liftoff/worker economic --only=reserve [--once]   # Conviction Reserve Worker saja
try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // .env opsional; tanpa SIGNER_AUTH_TOKEN worker menolak start.
}

const { randomUUID } = await import("node:crypto");
const { appDatabaseUrl, createPrismaClient } = await import("@liftoff/db");
const { createQuotePriceBook, createSolPriceOracle } = await import("@liftoff/shared");
const { assertRpcCluster, createConnection, RpcSender } = await import("@liftoff/solana");
const { loadEconomicConfig } = await import("./config");
const { EconomicEngine } = await import("./economic/engine");
const { RpcEconomicChain } = await import("./economic/rpc-chain");
const { ReserveWorker } = await import("./economic/reserve");
const { runWorkerCycle } = await import("./economic/runner");
import type { EconomicWorkerName } from "./economic/runner";
const { HttpSignerClient } = await import("./launch/signer-client");

const config = loadEconomicConfig();
const once = process.argv.includes("--once");
// `--only=reserve` = Conviction Reserve Worker saja (Spec §20C); default: ketiga worker.
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7) ?? null;

// Log JSON satu baris; tidak pernah memuat token, secret, URL RPC, atau isi transaksi.
const write = (level: "info" | "warn", obj: Record<string, unknown>, msg: string) =>
  console.warn(
    JSON.stringify(
      { level, time: new Date().toISOString(), service: "economic", msg, ...obj },
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    ),
  );
const logger = {
  info: (obj: Record<string, unknown>, msg: string) => write("info", obj, msg),
  warn: (obj: Record<string, unknown>, msg: string) => write("warn", obj, msg),
};

const db = createPrismaClient(appDatabaseUrl("worker"));
await assertRpcCluster(config.cluster, config.rpcUrl, config.rpcBackupUrl);
const connection = createConnection(config.rpcUrl, {
  backupUrl: config.rpcBackupUrl,
  cluster: config.cluster,
});
const e = config.economic;
const chain = new RpcEconomicChain(connection, config.platform, {
  computeUnitLimit: e.computeUnitLimit,
  computeUnitPriceMicroLamports: e.computeUnitPriceMicroLamports,
  graduatedRoute: e.graduatedRoute,
});
const engine = new EconomicEngine({
  db,
  chain,
  signer: new HttpSignerClient(config.signerUrl, config.signerAuthToken),
  sender: new RpcSender(connection),
  cluster: config.cluster,
  platform: config.platform,
  config: e,
  logger,
});
const reserve = new ReserveWorker({
  db,
  engine,
  chain,
  cluster: config.cluster,
  platform: config.platform,
  settings: config.reserve,
  // Mainnet: threshold reserve dinilai dengan harga SOL/USD nyata; null di devnet (harga asumsi).
  solPrice: createSolPriceOracle(config.cluster, config.solPrice),
  quotePrices: createQuotePriceBook(config.cluster, config.solPrice),
  logger,
});
const opts = {
  db,
  engine,
  chain,
  reserve,
  platform: config.platform,
  owner: `economic-${process.pid}-${randomUUID().slice(0, 8)}`,
  leaseMs: 10 * 60_000,
  logger,
  lowMasterBalanceLamports: BigInt(e.lowMasterBalanceLamports),
  alertConsecutiveFailures: e.alertConsecutiveFailures,
  nativeFeeFunds: e.feeIntake === "forwarded",
};

logger.info(
  {
    cluster: config.cluster,
    claimIntervalMs: e.claimIntervalMs,
    buybackIntervalMs: e.buybackIntervalMs,
    minClaimRaw: e.minClaimRaw,
    minBuybackRaw: e.minBuybackRaw,
    slippageBps: e.slippageBps,
    graduatedRoute: e.graduatedRoute,
    reserveIntervalMs: config.reserve.intervalMs,
    reserveMinBalanceToDeployUsd: config.reserve.config.minBalanceToDeployUsd,
    reserveConfigStatus: config.reserve.config.status,
    only,
  },
  "economic engine siap",
);

const enabled = (n: string) => !only || n === `economic:${only}`;
if (once) {
  if (enabled("economic:fee-processing")) await runWorkerCycle("economic:fee-processing", opts);
  if (enabled("economic:buyback")) await runWorkerCycle("economic:buyback", opts);
  if (enabled("economic:reserve")) await runWorkerCycle("economic:reserve", opts);
  await db.$disconnect();
  process.exit(0);
}

let stopping = false;
const timers: NodeJS.Timeout[] = [];
let busy = Promise.resolve();
// Siklus dijalankan berurutan (tidak tumpang tindih) supaya claim selesai sebelum buyback membaca budget.
const schedule = (name: EconomicWorkerName, every: number) => {
  if (!enabled(name)) return;
  const tick = () => {
    busy = busy.then(async () => {
      if (!stopping) await runWorkerCycle(name, opts);
    });
    void busy.then(() => {
      if (!stopping) timers.push(setTimeout(tick, every));
    });
  };
  tick();
};
schedule("economic:fee-processing", e.claimIntervalMs);
schedule("economic:buyback", e.buybackIntervalMs);
schedule("economic:reserve", config.reserve.intervalMs);

const shutdown = async () => {
  stopping = true;
  for (const t of timers) clearTimeout(t);
  await busy.catch(() => undefined);
  await db.$disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
