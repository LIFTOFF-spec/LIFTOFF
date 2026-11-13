import type { SystemStatus } from "@liftoff/db";
import type { SolPriceSnapshot } from "@liftoff/shared";
import { describe, expect, it } from "vitest";
import { loadMonitorConfig } from "../config";
import {
  AlertTracker,
  formatAlertText,
  TelegramNotifier,
  WebhookNotifier,
  type MonitorAlert,
} from "./alerts";
import { runMonitorChecks, type MonitorPorts } from "./checks";

const status = (alerts: MonitorAlert[] = []): SystemStatus =>
  ({ alerts, status: alerts.length ? "degraded" : "ok" }) as unknown as SystemStatus;

const healthy = (): MonitorPorts => ({
  systemStatus: async () => status(),
  redisPing: async () => true,
  masterLamports: async () => 3_000_000_000n,
  signerHealth: async () => ({ paused: false }),
});
const opts = { lowMasterBalanceLamports: 200_000_000n };
const codes = (a: MonitorAlert[]) => a.map((x) => x.code).sort();

describe("runMonitorChecks (skenario gagal)", () => {
  it("semua sehat → tanpa alert", async () => {
    expect(await runMonitorChecks(healthy(), opts)).toEqual([]);
  });

  it("Postgres, Redis, RPC, signer mati → masing-masing satu alert critical, tanpa exception", async () => {
    const down = async () => {
      throw new Error("ECONNREFUSED");
    };
    const alerts = await runMonitorChecks(
      { systemStatus: down, redisPing: down, masterLamports: down, signerHealth: down },
      opts,
    );
    expect(codes(alerts)).toEqual(["db_down", "redis_down", "rpc_down", "signer_down"]);
    expect(alerts.every((a) => a.level === "critical")).toBe(true);
  });

  it("saldo master rendah dibaca langsung dari chain; tidak dobel dengan alert DB", async () => {
    const p = healthy();
    p.masterLamports = async () => 100_000_000n;
    expect(codes(await runMonitorChecks(p, opts))).toEqual(["master_low_balance"]);
    p.systemStatus = async () =>
      status([{ level: "critical", code: "master_low_balance", message: "snapshot" }]);
    expect(codes(await runMonitorChecks(p, opts))).toEqual(["master_low_balance"]);
  });

  it("signer dipause → warn; signer tidak dikonfigurasi → tidak diperiksa", async () => {
    const p = healthy();
    p.signerHealth = async () => ({ paused: true });
    expect(await runMonitorChecks(p, opts)).toEqual([
      { level: "warn", code: "signer_paused", message: "signer dipause" },
    ]);
    p.signerHealth = null;
    expect(await runMonitorChecks(p, opts)).toEqual([]);
  });
});

describe("runMonitorChecks: harga SOL/USD", () => {
  const verified = { status: "verified", usd: 95, issues: [] } as unknown as SolPriceSnapshot;
  const unverified = {
    status: "unverified",
    usd: null,
    issues: ["deviation_too_large"],
  } as unknown as SolPriceSnapshot;

  it("terverifikasi atau cluster tanpa harga → tanpa alert; tidak terverifikasi → alert", async () => {
    const p = healthy();
    p.solPrice = null;
    expect(await runMonitorChecks(p, opts)).toEqual([]);
    p.solPrice = async () => verified;
    expect(await runMonitorChecks(p, opts)).toEqual([]);
    p.solPrice = async () => unverified;
    const [a] = await runMonitorChecks(p, opts);
    expect(a).toMatchObject({ level: "warn", code: "sol_price_unverified" });
    expect(a!.message).toContain("deviation_too_large");
  });

  it("pembacaan gagal juga alert, tanpa exception; alert sampai ke notifier sekali lalu pulih", async () => {
    const p = healthy();
    p.solPrice = async () => {
      throw new Error("boom");
    };
    const alerts = await runMonitorChecks(p, opts);
    expect(codes(alerts)).toEqual(["sol_price_unverified"]);
    const tracker = new AlertTracker(60_000);
    expect(tracker.update(alerts, 0).firing).toHaveLength(1);
    expect(tracker.update(alerts, 1_000).firing).toHaveLength(0);
    expect(tracker.update([], 2_000).resolved).toHaveLength(1);
    expect(formatAlertText("mainnet-beta", alerts, [])).toContain("sol_price_unverified");
  });
});

describe("AlertTracker", () => {
  const a = (code: string, message = "x"): MonitorAlert => ({ level: "critical", code, message });

  it("kirim saat muncul, tidak spam, ulang setelah repeatMs, laporkan pulih", () => {
    const t = new AlertTracker(60_000);
    expect(t.update([a("rpc_down")], 0).firing).toHaveLength(1);
    expect(t.update([a("rpc_down")], 10_000).firing).toHaveLength(0);
    // Angka berubah (saldo) tetap alert yang sama.
    t.update([a("master_low_balance", "saldo 100 < 200")], 10_000);
    expect(t.update([a("master_low_balance", "saldo 90 < 200")], 20_000).firing).toHaveLength(0);
    expect(
      t.update([a("rpc_down"), a("master_low_balance", "saldo 1 < 200")], 70_000).firing,
    ).toHaveLength(2);
    const r = t.update([], 80_000);
    expect(codes(r.resolved)).toEqual(["master_low_balance", "rpc_down"]);
    expect(t.update([], 90_000).resolved).toHaveLength(0);
  });
});

describe("notifier", () => {
  it("Telegram & webhook: payload benar, token tidak bocor di error", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const ok = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const text = formatAlertText("devnet", [a2()], []);
    await new TelegramNotifier("BOT:SECRET", "42", ok).send(text);
    await new WebhookNotifier("https://hooks.example/x", ok).send(text, {
      firing: [a2()],
      resolved: [],
    });
    expect(calls[0]!.url).toBe("https://api.telegram.org/botBOT:SECRET/sendMessage");
    expect(calls[0]!.body).toMatchObject({ chat_id: "42", text });
    expect(calls[1]!.body).toMatchObject({ text, firing: [a2()] });

    const failing = (async () => {
      throw new Error("connect failed https://api.telegram.org/botBOT:SECRET/sendMessage");
    }) as unknown as typeof fetch;
    const err = await new TelegramNotifier("BOT:SECRET", "42", failing).send(text).catch((e) => e);
    expect(String(err)).not.toContain("SECRET");
  });

  it("pesan alert tidak memuat URL RPC", () => {
    const text = formatAlertText(
      "devnet",
      [{ level: "critical", code: "worker_failing", message: "x https://rpc.example/?api-key=K" }],
      [],
    );
    expect(text).not.toContain("api-key=K");
  });

  it("config: notifier mati bila kosong; Telegram wajib berpasangan; webhook wajib https", () => {
    const base = { SOLANA_CLUSTER: "devnet" } as NodeJS.ProcessEnv;
    const c = loadMonitorConfig(base);
    expect(c.telegram).toBeNull();
    expect(c.webhookUrl).toBeNull();
    expect(() => loadMonitorConfig({ ...base, ALERT_TELEGRAM_BOT_TOKEN: "x" })).toThrow();
    expect(() =>
      loadMonitorConfig({ ...base, ALERT_WEBHOOK_URL: "http://evil.example" }),
    ).toThrow();
  });
});

function a2(): MonitorAlert {
  return { level: "warn", code: "signer_paused", message: "signer dipause" };
}
