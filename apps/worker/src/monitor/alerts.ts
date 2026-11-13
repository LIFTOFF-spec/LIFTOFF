/**
 * Alert & notifikasi eksternal (Tahap 9). Proses monitor memanggil `AlertTracker.update()` tiap
 * siklus; yang baru muncul (atau masih aktif setelah `repeatMs`) dan yang pulih dikirim ke
 * notifier. Notifier opsional: Telegram bot dan/atau webhook JSON; tanpa config = hanya log.
 * Token bot / URL webhook tidak pernah di-log atau ikut pesan error.
 */
import { redactSecrets } from "@liftoff/db";

export interface MonitorAlert {
  level: "warn" | "critical";
  code: string;
  message: string;
}

export interface AlertNotifier {
  readonly name: string;
  send(text: string, payload: { firing: MonitorAlert[]; resolved: MonitorAlert[] }): Promise<void>;
}

/** Kunci stabil per alert: kode + pesan tanpa angka (saldo/hitungan berubah tiap siklus). */
export function alertKey(a: MonitorAlert): string {
  return `${a.code}|${a.message.replace(/[0-9]+/g, "#")}`;
}

export class AlertTracker {
  private active = new Map<string, { alert: MonitorAlert; sentAt: number }>();

  constructor(private readonly repeatMs: number) {}

  /** Mengembalikan alert yang perlu dikirim sekarang: baru / diulang / sudah pulih. */
  update(alerts: MonitorAlert[], now: number) {
    const firing: MonitorAlert[] = [];
    const seen = new Set<string>();
    for (const a of alerts) {
      const key = alertKey(a);
      if (seen.has(key)) continue;
      seen.add(key);
      const prev = this.active.get(key);
      if (!prev || now - prev.sentAt >= this.repeatMs || prev.alert.level !== a.level) {
        firing.push(a);
        this.active.set(key, { alert: a, sentAt: now });
      } else {
        prev.alert = a;
      }
    }
    const resolved: MonitorAlert[] = [];
    for (const [key, v] of this.active) {
      if (!seen.has(key)) {
        resolved.push(v.alert);
        this.active.delete(key);
      }
    }
    return { firing, resolved };
  }
}

export function formatAlertText(
  cluster: string,
  firing: MonitorAlert[],
  resolved: MonitorAlert[],
): string {
  const lines = [`LIFTOFF ${cluster}`];
  for (const a of firing)
    lines.push(`${a.level === "critical" ? "🔴" : "🟠"} ${a.code}: ${a.message}`);
  for (const a of resolved) lines.push(`✅ pulih ${a.code}: ${a.message}`);
  return redactSecrets(lines.join("\n"))!;
}

async function post(fetchImpl: typeof fetch, url: string, body: unknown, label: string) {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    // Pesan error fetch bisa memuat URL (token bot): jangan diteruskan.
    throw new Error(`${label}: gagal terhubung (${(err as Error).name})`);
  }
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
}

export class TelegramNotifier implements AlertNotifier {
  readonly name = "telegram";
  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  send(text: string) {
    return post(
      this.fetchImpl,
      `https://api.telegram.org/bot${this.botToken}/sendMessage`,
      { chat_id: this.chatId, text, disable_web_page_preview: true },
      "telegram",
    );
  }
}

export class WebhookNotifier implements AlertNotifier {
  readonly name = "webhook";
  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  send(text: string, payload: { firing: MonitorAlert[]; resolved: MonitorAlert[] }) {
    return post(this.fetchImpl, this.url, { text, ...payload }, "webhook");
  }
}
