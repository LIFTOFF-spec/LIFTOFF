import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

/**
 * IP klien untuk rate limit & batas launch per IP (Tahap 11a, Cloudflare di depan Caddy).
 * Caddy menimpa X-Forwarded-For dengan satu IP asli; API hanya memercayai satu hop (Caddy),
 * jadi entri tambahan yang dikirim klien tidak pernah dipakai.
 */
async function ipFor(
  env: Record<string, string>,
  headers: Record<string, string>,
  remoteAddress = "172.18.0.5", // Caddy di jaringan Docker
) {
  const app = Fastify({ trustProxy: loadConfig(env as NodeJS.ProcessEnv).trustProxy });
  app.get("/ip", (req) => ({ ip: req.ip }));
  const res = await app.inject({ method: "GET", url: "/ip", headers, remoteAddress });
  await app.close();
  return res.json().ip as string;
}

describe("IP klien di belakang Caddy", () => {
  it("TRUST_PROXY=1: memakai IP yang ditulis Caddy", async () => {
    expect(await ipFor({ TRUST_PROXY: "1" }, { "x-forwarded-for": "203.0.113.7" })).toBe(
      "203.0.113.7",
    );
  });

  it("TRUST_PROXY=1: entri X-Forwarded-For palsu dari klien diabaikan", async () => {
    const ip = await ipFor({ TRUST_PROXY: "1" }, { "x-forwarded-for": "6.6.6.6, 203.0.113.7" });
    expect(ip).toBe("203.0.113.7");
  });

  it("tanpa TRUST_PROXY: header diabaikan, IP socket dipakai", async () => {
    expect(await ipFor({}, { "x-forwarded-for": "6.6.6.6" })).toBe("172.18.0.5");
    expect(loadConfig({ TRUST_PROXY: "0" } as NodeJS.ProcessEnv).trustProxy).toBe(false);
  });

  it("peer publik (bukan Caddy) tidak dipercaya walau TRUST_PROXY=1", async () => {
    const ip = await ipFor({ TRUST_PROXY: "1" }, { "x-forwarded-for": "6.6.6.6" }, "198.51.100.9");
    expect(ip).toBe("198.51.100.9");
  });

  it("header CF-Connecting-IP langsung ke API tidak dipercaya", async () => {
    expect(await ipFor({ TRUST_PROXY: "1" }, { "cf-connecting-ip": "6.6.6.6" })).toBe("172.18.0.5");
  });
});
