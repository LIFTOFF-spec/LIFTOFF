// Signer service (Tahap 4): satu-satunya proses yang memegang key master wallet.
// Hanya mendengarkan di jaringan internal (default 127.0.0.1) dan butuh SIGNER_AUTH_TOKEN.
try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // .env opsional; tanpa SIGNER_KEYPAIR_PATH & SIGNER_AUTH_TOKEN signer menolak start.
}

const { appDatabaseUrl, createPrismaClient } = await import("@liftoff/db");
const { assertRpcCluster, createConnection } = await import("@liftoff/solana");
const { buildSignerApp } = await import("./app");
const { RpcSignerChain } = await import("./chain");
const { loadSignerConfig } = await import("./config");
const { loadMasterKeypair } = await import("./keys");
const { SignerService } = await import("./service");

const config = loadSignerConfig();
const master = loadMasterKeypair(config.keypairPath);
await assertRpcCluster(config.cluster, config.rpcUrl, config.backupRpcUrl);
const db = createPrismaClient(appDatabaseUrl("signer"));
const service = new SignerService({
  db,
  // F8: baca failover ke RPC cadangan; cek silang aksi besar memakai cadangan secara terpisah.
  chain: new RpcSignerChain(
    createConnection(config.rpcUrl, { backupUrl: config.backupRpcUrl, cluster: config.cluster }),
    config.platform,
    config.cluster,
    config.backupRpcUrl
      ? new RpcSignerChain(
          createConnection(config.backupRpcUrl, { cluster: config.cluster }),
          config.platform,
          config.cluster,
        )
      : null,
  ),
  master,
  config,
});
const app = buildSignerApp(service, config, { logger: true });
app.addHook("onClose", async () => {
  await db.$disconnect();
});

if (config.host !== "127.0.0.1" && config.host !== "::1" && config.host !== "localhost") {
  app.log.warn(`signer mendengarkan di ${config.host}: pastikan hanya jaringan internal`);
}
if (config.authTokens.some((t) => t.scope === "all")) {
  app.log.warn(
    "SIGNER_AUTH_TOKEN (cakupan semua tujuan) masih aktif: pakai SIGNER_LAUNCH_TOKEN + SIGNER_ECONOMIC_TOKEN (F12)",
  );
}
try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      masterWallet: config.platform.masterWallet,
      cluster: config.cluster,
      paused: await service.isPaused(),
      tokenScopes: config.authTokens.map((t) => t.scope),
      backupRpc: !!config.backupRpcUrl,
    },
    "signer siap",
  );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
