import {
  defaultSystemStatusOptions,
  economicHealth,
  redactEconomicHealth,
  systemStatus,
} from "@liftoff/db";
import {
  MONITOR_CONFIG,
  solPriceAlert,
  type EconomicHealthResponse,
  type HealthCheckState,
  type HealthResponse,
  type SystemStatusResponse,
} from "@liftoff/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";

async function probe(fn: () => Promise<boolean>): Promise<HealthCheckState> {
  try {
    return (await fn()) ? "ok" : "down";
  } catch {
    return "down";
  }
}

/**
 * Endpoint health tidak terkena rate limit (monitoring harus selalu bisa membaca), jadi hasil probe
 * di-cache singkat agar request beruntun tidak meneruskan beban ke RPC/signer.
 */
const PROBE_CACHE_MS = 5_000;
const probeCache = new WeakMap<
  AppContext,
  { at: number; value: ReturnType<typeof runInfraChecks> }
>();

function infraChecks(ctx: AppContext) {
  const hit = probeCache.get(ctx);
  if (hit && Date.now() - hit.at < PROBE_CACHE_MS) return hit.value;
  const value = runInfraChecks(ctx);
  probeCache.set(ctx, { at: Date.now(), value });
  return value;
}

/** Probe infrastruktur. Signer: /health internal juga melaporkan status pause. */
async function runInfraChecks(ctx: AppContext) {
  let signerPaused: boolean | null = null;
  const [db, redis, rpc, signer] = await Promise.all([
    probe(async () => {
      await ctx.db.$queryRaw`SELECT 1`;
      return true;
    }),
    probe(() => ctx.kv.ping()),
    probe(async () => {
      const res = await ctx.fetchImpl(ctx.config.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
        signal: AbortSignal.timeout(MONITOR_CONFIG.probeTimeoutMs),
      });
      const body = (await res.json()) as { result?: unknown };
      return res.ok && body.result === "ok";
    }),
    ctx.config.signerUrl
      ? probe(async () => {
          const res = await ctx.fetchImpl(new URL("/health", ctx.config.signerUrl!), {
            signal: AbortSignal.timeout(2_000),
          });
          const body = (await res.json().catch(() => null)) as { paused?: unknown } | null;
          if (typeof body?.paused === "boolean") signerPaused = body.paused;
          return res.ok;
        })
      : Promise.resolve<HealthCheckState>("not_configured"),
  ]);
  return { checks: { db, redis, rpc, signer }, signerPaused };
}

export async function healthRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/health", async (_req, reply) => {
    const { checks } = await infraChecks(ctx);
    const healthy =
      checks.db === "ok" &&
      checks.redis === "ok" &&
      checks.rpc === "ok" &&
      checks.signer !== "down";
    const body: HealthResponse = {
      status: healthy ? "ok" : "degraded",
      service: "api",
      cluster: ctx.config.cluster,
      checks,
    };
    return reply.status(healthy ? 200 : 503).send(body);
  });

  /**
   * Ringkasan status (Tahap 9): infrastruktur + economic engine + Conviction Reserve worker +
   * indexer + launch job macet + signer dipause, dalam satu respons. Pesan dibersihkan dari URL.
   */
  app.get("/api/health/status", async (_req, reply) => {
    const now = new Date();
    const { checks, signerPaused } = await infraChecks(ctx);
    const alerts: SystemStatusResponse["alerts"] = [];
    for (const [name, state] of Object.entries(checks)) {
      if (state === "down") {
        alerts.push({
          level: "critical",
          code: `${name}_down`,
          message: `${name} tidak terjangkau`,
        });
      }
    }
    if (signerPaused) {
      alerts.push({ level: "warn", code: "signer_paused", message: "signer dipause" });
    }
    const price = ctx.solPrice?.current();
    if (price?.status === "unverified") alerts.push(solPriceAlert(price));
    let body: SystemStatusResponse;
    try {
      const sys = await systemStatus(ctx.db, defaultSystemStatusOptions(now));
      // signer_paused dari DB dan dari probe adalah alert yang sama.
      for (const a of sys.alerts) {
        if (!alerts.some((x) => x.code === a.code && x.message === a.message)) {
          if (a.code === "signer_paused" && signerPaused) continue;
          alerts.push(a);
        }
      }
      body = {
        status: alerts.some((a) => a.level === "critical") ? "degraded" : "ok",
        service: "api",
        cluster: ctx.config.cluster,
        checkedAt: now.toISOString(),
        checks,
        signer: { reachable: checks.signer, paused: signerPaused ?? sys.signerPaused },
        alerts,
        indexer: sys.indexer,
        economic: sys.economic,
      };
    } catch {
      body = {
        status: "down",
        service: "api",
        cluster: ctx.config.cluster,
        checkedAt: now.toISOString(),
        checks,
        signer: { reachable: checks.signer, paused: signerPaused },
        alerts: alerts.length
          ? alerts
          : [{ level: "critical", code: "status_unavailable", message: "status DB tidak terbaca" }],
        indexer: null,
        economic: null,
      };
    }
    return reply.status(body.status === "ok" ? 200 : 503).send(body);
  });
}

/** Alert dasar economic engine (Tahap 7): worker gagal, saldo master rendah, selisih ledger. */
export function economicHealthOptions(now = new Date()) {
  return { ...defaultSystemStatusOptions(now).economic, now };
}

export async function economicHealthRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/health/economic", async (_req, reply) => {
    const body: EconomicHealthResponse = redactEconomicHealth(
      await economicHealth(ctx.db, economicHealthOptions()),
    );
    return reply.status(body.status === "ok" ? 200 : 503).send(body);
  });
}
