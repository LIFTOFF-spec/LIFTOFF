/**
 * Satu siklus pemeriksaan monitor (Tahap 9): status DB (`systemStatus`), Redis, RPC + saldo SOL
 * master langsung dari chain, signer (/health: hidup + pause), dan harga SOL/USD. Setiap port bisa gagal sendiri;
 * kegagalan menjadi alert, bukan exception, sehingga DB mati tetap terlaporkan lewat notifier.
 */
import type { SystemStatus } from "@liftoff/db";
import { solPriceAlert, type SolPriceSnapshot } from "@liftoff/shared";
import type { MonitorAlert } from "./alerts";

export interface MonitorPorts {
  systemStatus(): Promise<SystemStatus>;
  redisPing(): Promise<boolean>;
  masterLamports(): Promise<bigint>;
  /** null = signer tidak dikonfigurasi. */
  signerHealth: (() => Promise<{ paused: boolean }>) | null;
  /** null = cluster tanpa harga nyata (devnet memakai harga asumsi). */
  solPrice?: (() => Promise<SolPriceSnapshot>) | null;
}

export async function runMonitorChecks(
  ports: MonitorPorts,
  opts: { lowMasterBalanceLamports: bigint },
): Promise<MonitorAlert[]> {
  const alerts: MonitorAlert[] = [];
  const crit = (code: string, message: string) => alerts.push({ level: "critical", code, message });

  const [sys, redis, lamports, signer, price] = await Promise.allSettled([
    ports.systemStatus(),
    ports.redisPing(),
    ports.masterLamports(),
    ports.signerHealth ? ports.signerHealth() : Promise.resolve(null),
    ports.solPrice ? ports.solPrice() : Promise.resolve(null),
  ]);

  if (sys.status === "fulfilled") alerts.push(...sys.value.alerts);
  else crit("db_down", "status DB tidak terbaca (Postgres mati/tidak terjangkau?)");

  if (redis.status === "rejected" || redis.value !== true) {
    crit("redis_down", "Redis tidak terjangkau: queue launch & rate limit API tertahan");
  }

  if (lamports.status === "rejected") {
    crit("rpc_down", "RPC tidak menjawab getBalance master wallet");
  } else if (lamports.value < opts.lowMasterBalanceLamports) {
    // Saldo langsung dari chain; snapshot worker fee-processing bisa sudah usang.
    if (!alerts.some((a) => a.code === "master_low_balance")) {
      crit(
        "master_low_balance",
        `saldo SOL master wallet ${lamports.value} lamport < ${opts.lowMasterBalanceLamports}`,
      );
    }
  }

  if (signer.status === "rejected") {
    crit("signer_down", "signer tidak menjawab /health: launch & economic engine tertahan");
  } else if (signer.value?.paused && !alerts.some((a) => a.code === "signer_paused")) {
    alerts.push({ level: "warn", code: "signer_paused", message: "signer dipause" });
  }

  if (price.status === "rejected") {
    alerts.push(solPriceAlert(null));
  } else if (price.value?.status === "unverified") {
    alerts.push(solPriceAlert(price.value));
  }
  return alerts;
}
