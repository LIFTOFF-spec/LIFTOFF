// Monitor & alert (Tahap 9): proses terpisah, TANPA key dan tanpa token signer. Tiap
// MONITOR_INTERVAL_MS memeriksa DB (semua alert economic/reserve/indexer/launch), Redis, RPC +
// saldo master, signer /health, dan harga SOL/USD (mainnet); alert baru/pulih ditulis ke log (`ALERT:`) dan, bila
// dikonfigurasi, dikirim ke Telegram (ALERT_TELEGRAM_BOT_TOKEN + ALERT_TELEGRAM_CHAT_ID) dan/atau
// webhook (ALERT_WEBHOOK_URL). Tanpa config notifikasi = hanya log.
//   pnpm --filter @liftoff/worker monitor           # loop
//   pnpm --filter @liftoff/worker monitor --once    # satu pemeriksaan, cetak ringkasan, keluar
try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // .env opsional.
}

const { appDatabaseUrl, createPrismaClient, defaultSystemStatusOptions, systemStatus } =
  await import("@liftoff/db");
const { createSolPriceOracle, ECONOMIC_CONFIG } = await import("@liftoff/shared");
const { assertRpcCluster, createConnection } = await import("@liftoff/solana");
const { PublicKey } = await import("@solana/web3.js");
const { Redis } = await import("ioredis");
const { loadMonitorConfig } = await import("./config");
const { AlertTracker, formatAlertText, TelegramNotifier, WebhookNotifier } =
  await import("./monitor/alerts");
const { runMonitorChecks } = await import("./monitor/checks");
import type { SolPriceSnapshot } from "@liftoff/shared";
import type { AlertNotifier } from "./monitor/alerts";

const config = loadMonitorConfig();
const once = process.argv.includes("--once");

// Log JSON satu baris; tidak pernah memuat URL RPC, token bot, atau URL webhook.
const log = (level: "info" | "warn", obj: Record<string, unknown>, msg: string) =>
  console.warn(
    JSON.stringify({ level, time: new Date().toISOString(), service: "monitor", msg, ...obj }),
  );

const db = createPrismaClient(appDatabaseUrl("worker"));
await assertRpcCluster(config.cluster, config.rpcUrl, config.rpcBackupUrl);
const connection = createConnection(config.rpcUrl, {
  backupUrl: config.rpcBackupUrl,
  cluster: config.cluster,
});
const redis = new Redis(config.redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  connectTimeout: 3_000,
  enableOfflineQueue: false,
});
redis.on("error", () => undefined);
const master = new PublicKey(config.platform.masterWallet);

const notifiers: AlertNotifier[] = [];
if (config.telegram) {
  notifiers.push(new TelegramNotifier(config.telegram.botToken, config.telegram.chatId));
}
if (config.webhookUrl) notifiers.push(new WebhookNotifier(config.webhookUrl));

const withTimeout = <T>(p: Promise<T>, ms = 5_000) =>
  Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);

const tracker = new AlertTracker(config.repeatAlertMs);
const solPrice = createSolPriceOracle(config.cluster, config.solPrice);

async function cycle() {
  const alerts = await runMonitorChecks(
    {
      systemStatus: () => withTimeout(systemStatus(db, defaultSystemStatusOptions())),
      redisPing: async () => {
        if (redis.status === "wait" || redis.status === "end")
          await redis.connect().catch(() => undefined);
        return (await withTimeout(redis.ping())) === "PONG";
      },
      masterLamports: async () =>
        BigInt(await withTimeout(connection.getBalance(master, "confirmed"))),
      signerHealth: config.signerUrl
        ? async () => {
            const res = await fetch(new URL("/health", config.signerUrl!), {
              signal: AbortSignal.timeout(3_000),
            });
            if (!res.ok) throw new Error(`signer HTTP ${res.status}`);
            return { paused: ((await res.json()) as { paused?: boolean }).paused === true };
          }
        : null,
      // Menunggu pembacaan sebentar saja: `Retry-After` panjang tidak boleh menahan cek lain.
      solPrice: solPrice
        ? () =>
            Promise.race([
              solPrice.read(),
              new Promise<SolPriceSnapshot>((resolve) =>
                setTimeout(() => resolve(solPrice.current()), 5_000),
              ),
            ])
        : null,
    },
    { lowMasterBalanceLamports: BigInt(ECONOMIC_CONFIG.lowMasterBalanceLamports) },
  );
  const { firing, resolved } = tracker.update(alerts, Date.now());
  for (const a of firing) log("warn", { code: a.code, severity: a.level }, `ALERT: ${a.message}`);
  for (const a of resolved) log("info", { code: a.code }, `RESOLVED: ${a.message}`);
  if ((firing.length || resolved.length) && notifiers.length) {
    const text = formatAlertText(config.cluster, firing, resolved);
    for (const n of notifiers) {
      await n
        .send(text, { firing, resolved })
        .catch((err: Error) =>
          log("warn", { notifier: n.name }, `notifikasi gagal: ${err.message}`),
        );
    }
  }
  if (once)
    log("info", { active: alerts.length, codes: alerts.map((a) => a.code) }, "monitor selesai");
}

log("info", { cluster: config.cluster, notifiers: notifiers.map((n) => n.name) }, "monitor mulai");
if (once) {
  await cycle();
} else {
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  while (!stopping) {
    await cycle().catch((err: Error) => log("warn", {}, `siklus monitor gagal: ${err.message}`));
    await new Promise((r) => setTimeout(r, config.intervalMs));
  }
}
redis.disconnect();
await db.$disconnect();
