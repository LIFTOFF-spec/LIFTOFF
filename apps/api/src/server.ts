try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // .env opsional di development; nilai default dipakai.
}

const { appDatabaseUrl, createPrismaClient } = await import("@liftoff/db");
const { buildApp } = await import("./app");
const { loadConfig } = await import("./config");
const { JupiterTickerSource } = await import("./lib/external-tickers");
const { RedisKvStore } = await import("./lib/kv");
const { RpcWalletChecker } = await import("./lib/wallet-check");
const { BullMqLaunchEnqueuer } = await import("./lib/launch-queue");
const { RpcDepositVerifier } = await import("./lib/deposit");
const { RpcTradeService } = await import("./lib/trade");
const { createQuotePriceBook, createSolPriceOracle, platformFor } = await import("@liftoff/shared");
const { assertRpcCluster, createConnection } = await import("@liftoff/solana");
const { createStonkFunAdapter } = await import("@liftoff/solana/stonkfun");

const port = Number(process.env.API_PORT ?? 4000);
const host = process.env.API_HOST ?? "0.0.0.0";

const config = loadConfig();
await assertRpcCluster(config.cluster, config.rpcUrl, config.rpcBackupUrl);
const db = createPrismaClient(appDatabaseUrl("api"));
const kv = new RedisKvStore(process.env.REDIS_URL ?? "redis://localhost:6379");
const external = new JupiterTickerSource(
  config.jupiterApiUrl,
  config.antiCopycat.externalLookupTimeoutMs,
  kv,
);

const walletChecker = new RpcWalletChecker(config.rpcUrl);

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const launchQueue = new BullMqLaunchEnqueuer(redisUrl);
const depositVerifier = new RpcDepositVerifier(config.rpcUrl);
const trade = new RpcTradeService({
  rpcUrl: config.rpcUrl,
  rpcBackupUrl: config.rpcBackupUrl,
  cluster: config.cluster,
  platform: platformFor(config.cluster),
  referralWallet: config.tradeReferralWallet,
  graduatedRoute: config.tradeGraduatedRoute,
});

// Spec §3–6: StonkFun lewat adapter. Devnet = emulasi (Platform PDA LIFTOFF + global config
// Raydium on-chain); mainnet = Developer API StonkFun.
const stonkfun = createStonkFunAdapter({
  connection: createConnection(config.rpcUrl, {
    backupUrl: config.rpcBackupUrl,
    cluster: config.cluster,
  }),
  platform: platformFor(config.cluster),
  cluster: config.cluster,
  // StonkFun asli tetap terkunci kecuali flag eksplisit (dan mainnet-beta).
  mainnetEnabled: process.env.STONKFUN_MAINNET_ENABLED === "1",
});

// Harga SOL/USD mainnet (null di devnet). Dibaca berkala di belakang, tidak pernah menahan request.
const solPrice = createSolPriceOracle(config.cluster, config.solPrice, stonkfun);
const quotePrices = createQuotePriceBook(config.cluster, config.solPrice, stonkfun);
solPrice?.current();
const solPriceTimer = solPrice
  ? setInterval(() => solPrice.current(), config.solPrice.config.refreshMs)
  : null;
solPriceTimer?.unref();

const app = buildApp({
  db,
  kv,
  external,
  walletChecker,
  launchQueue,
  depositVerifier,
  trade,
  stonkfun,
  solPrice,
  quotePrices,
  config,
  logger: true,
});

if (!config.xOAuth) {
  app.log.warn(
    config.devXLinkEnabled
      ? "X_CLIENT_ID/X_CLIENT_SECRET kosong: tautan X opsional memakai DEV LINK (hanya development)."
      : "X_CLIENT_ID/X_CLIENT_SECRET kosong: tautan X opsional tidak tersedia.",
  );
}

app.addHook("onClose", async () => {
  if (solPriceTimer) clearInterval(solPriceTimer);
  await db.$disconnect();
  await kv.close();
  await launchQueue.close();
});

try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
