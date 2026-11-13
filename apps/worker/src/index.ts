// Worker BullMQ (Tahap 4: queue `launch`). Worker TIDAK memegang key apa pun: transaksi
// dibangun tanpa tanda tangan lalu ditandatangani apps/signer lewat jaringan internal.
try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // .env opsional; tanpa SIGNER_AUTH_TOKEN worker menolak start.
}

const { appDatabaseUrl, createPrismaClient } = await import("@liftoff/db");
const { assertRpcCluster, createConnection, JitoSender, RpcSender } =
  await import("@liftoff/solana");
const { Redis } = await import("ioredis");
const { loadWorkerConfig } = await import("./config");
const { LaunchEngine } = await import("./launch/engine");
const { createLaunchQueue, createLaunchWorker, sweepStaleLaunches } =
  await import("./launch/queue");
const { RpcLaunchChain } = await import("./launch/rpc-chain");
const { HttpSignerClient } = await import("./launch/signer-client");
const { createStonkFunAdapter } = await import("@liftoff/solana/stonkfun");

const config = loadWorkerConfig();

// Log JSON satu baris; tidak pernah memuat token, secret, atau isi transaksi.
const write = (level: "info" | "warn", obj: Record<string, unknown>, msg: string) =>
  console.warn(
    JSON.stringify({ level, time: new Date().toISOString(), service: "worker", msg, ...obj }),
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
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
const sender =
  config.engine.sendMode === "jito"
    ? new JitoSender(config.jitoBlockEngineUrl!)
    : new RpcSender(connection);

const engine = new LaunchEngine({
  db,
  chain: new RpcLaunchChain(
    connection,
    config.platform,
    config.engine.jitoTipLamports,
    config.devnetFundRaisingOverride,
  ),
  signer: new HttpSignerClient(config.signerUrl, config.signerAuthToken),
  sender,
  cluster: config.cluster,
  config: config.engine,
  // cacheMs 0: config dibaca segar tepat sebelum transaksi create dibangun.
  stonkfun: createStonkFunAdapter({
    connection,
    platform: config.platform,
    cluster: config.cluster,
    cacheMs: 0,
    // StonkFun asli tetap terkunci kecuali flag eksplisit (dan mainnet-beta).
    mainnetEnabled: process.env.STONKFUN_MAINNET_ENABLED === "1",
  }),
  metadataUri: (tokenId) => `${config.publicApiUrl}/api/metadata/${tokenId}.json`,
  logger,
});

const queue = createLaunchQueue(redis);
const worker = createLaunchWorker({
  connection: redis,
  engine,
  db,
  concurrency: config.concurrency,
  logger,
});

const sweep = async () => {
  try {
    const ids = await sweepStaleLaunches(db, queue, config.engine);
    if (ids.length) logger.info({ count: ids.length }, "sweeper mengantrekan ulang launch");
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "sweeper gagal");
  }
};
// Saat start: ambil ulang semua job yang tertinggal (mis. worker restart di tengah job).
await sweepStaleLaunches(db, queue, { ...config.engine, staleAfterMs: 0 });
const timer = setInterval(sweep, config.engine.sweepIntervalMs);
logger.info({ cluster: config.cluster, sendMode: config.engine.sendMode }, "worker launch siap");
if (config.devnetFundRaisingOverride) {
  logger.warn(
    { totalFundRaisingB: config.devnetFundRaisingOverride.toString() },
    "LAUNCH_DEVNET_FUND_RAISING_RAW aktif: launch baru memakai target graduation uji (devnet)",
  );
}

const shutdown = async () => {
  clearInterval(timer);
  await worker.close();
  await queue.close();
  await redis.quit();
  await db.$disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
