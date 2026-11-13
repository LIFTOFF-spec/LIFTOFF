/**
 * Helper test: menyiapkan database Postgres terpisah per paket (mis. `liftoff_test_api`)
 * lalu menjalankan semua migrasi. Butuh Postgres dari docker-compose (`pnpm db:up`).
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { DEFAULT_DATABASE_URL } from "./index";

export function testDatabaseUrl(name: string): string {
  const base = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  base.pathname = `/${name}`;
  return base.toString();
}

export async function prepareTestDatabase(name: string): Promise<string> {
  if (!/^liftoff_test_[a-z0-9_]+$/.test(name)) {
    throw new Error("nama database test harus diawali liftoff_test_");
  }
  const url = testDatabaseUrl(name);
  const admin = new pg.Client({ connectionString: testDatabaseUrl("postgres") });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `Postgres tidak bisa dihubungi (${(err as Error).message}). Jalankan \`pnpm db:up\` dulu.`,
    );
  }
  try {
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }

  const require = createRequire(import.meta.url);
  const prismaCli = require.resolve("prisma/build/index.js");
  execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  return url;
}

/** Mengosongkan tabel non-ledger (tabel ledger append-only memang tidak bisa dikosongkan). */
export const RESETTABLE_TABLES = [
  "quote_assets",
  "launch_appeals",
  "token_markets",
  "indexer_checkpoints",
  "token_graduations",
  "trade_receipts",
  "launch_deposits",
  "transactions",
  "launch_jobs",
  "ticker_claims",
  "x_account_claims",
  "tokens",
  "users",
  "reserve_config_overrides",
  "launch_deposits",
  "signer_spends",
  "system_flags",
  "worker_heartbeats",
] as const;
