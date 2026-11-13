// Indexer pasar & worker graduation (Tahap 6). Proses terpisah dari worker launch: hanya membaca
// chain (RPC devnet; Helius opsional lewat INDEXER_RPC_URL) dan menulis DB. Tidak memegang key.
try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // .env opsional.
}

const { appDatabaseUrl, createPrismaClient } = await import("@liftoff/db");
const { assertRpcCluster, createConnection } = await import("@liftoff/solana");
const { MarketReader } = await import("@liftoff/solana/market");
const { loadIndexerConfig } = await import("./config");
const { MarketIndexer } = await import("./indexer/indexer");
const { Backoff, RateLimiter } = await import("./indexer/throttle");

const config = loadIndexerConfig();
await assertRpcCluster(config.cluster, config.rpcUrl, config.rpcBackupUrl);

// Log JSON satu baris; URL RPC tidak pernah di-log (bisa memuat API key).
const write = (level: "info" | "warn", obj: Record<string, unknown>, msg: string) =>
  console.warn(
    JSON.stringify({ level, time: new Date().toISOString(), service: "indexer", msg, ...obj }),
  );
const logger = {
  info: (obj: Record<string, unknown>, msg: string) => write("info", obj, msg),
  warn: (obj: Record<string, unknown>, msg: string) => write("warn", obj, msg),
};

const db = createPrismaClient(appDatabaseUrl("worker"));
const limiter = new RateLimiter(config.indexer.rpcMinIntervalMs);
const chain = new MarketReader(
  createConnection(config.rpcUrl, { backupUrl: config.rpcBackupUrl, cluster: config.cluster }),
  {
    launchlabProgram: config.platform.launchlabProgram,
    cpmmProgram: config.platform.cpmmProgram,
    platformId: config.platform.platformId,
    beforeCall: () => limiter.wait(),
  },
);
const indexer = new MarketIndexer({
  db,
  chain,
  cluster: config.cluster,
  masterWallet: config.platform.masterWallet,
  config: config.indexer,
  logger,
});
const backoff = new Backoff(config.indexer.backoffInitialMs, config.indexer.backoffMaxMs);

let stopping = false;
let timer: NodeJS.Timeout | null = null;

async function loop() {
  let delay = config.indexer.pollIntervalMs;
  const started = Date.now();
  try {
    const r = await indexer.runCycle();
    backoff.reset();
    logger.info({ ...r, ms: Date.now() - started }, "indexer: siklus selesai");
  } catch (err) {
    delay = backoff.fail();
    logger.warn({ err: (err as Error).message, retryInMs: delay }, "indexer: RPC error, backoff");
  }
  if (!stopping) timer = setTimeout(() => void loop(), delay);
}

logger.info(
  { cluster: config.cluster, pollIntervalMs: config.indexer.pollIntervalMs },
  "indexer siap",
);
void loop();

const shutdown = async () => {
  stopping = true;
  if (timer) clearTimeout(timer);
  await db.$disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
