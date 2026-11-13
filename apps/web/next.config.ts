import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

/** API LIFTOFF (apps/api). Browser memanggil /api/* di origin web; Next meneruskannya ke sini. */
const apiUrl = process.env.API_INTERNAL_URL ?? "http://localhost:4000";
const dev = process.env.NODE_ENV !== "production";

/**
 * Header keamanan (Tahap 9). CSP: script hanya dari origin sendiri ('unsafe-inline' dibutuhkan
 * skrip inline App Router tanpa nonce; 'unsafe-eval' hanya development untuk HMR). connect-src
 * https:/wss: untuk RPC Solana pilihan wallet. Tanpa framing (clickjacking pada tombol sign).
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  // Modal wallet-adapter memuat font DM Sans dari Google Fonts.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https:",
  "font-src 'self' https://fonts.gstatic.com",
  "media-src 'self'",
  `connect-src 'self' https: wss:${dev ? " ws: http://localhost:* http://127.0.0.1:*" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(dev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  ...(dev
    ? []
    : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]),
];

const nextConfig: NextConfig = {
  // Tahap 10b: image Docker produksi memakai server mandiri (.next/standalone); root tracing =
  // root monorepo supaya paket workspace ikut tersalin.
  output: "standalone",
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
  // Paket workspace berisi source TypeScript.
  transpilePackages: ["@liftoff/shared"],
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiUrl}/api/:path*` }];
  },
};

export default nextConfig;
