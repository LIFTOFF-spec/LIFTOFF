import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "./generated/prisma/client";

export * from "./generated/prisma/client";

/** Default sama dengan docker-compose.yml (kredensial lokal development, bukan secret). */
export const DEFAULT_DATABASE_URL = "postgresql://liftoff:liftoff@localhost:5432/liftoff";

export type AppRole = "api" | "worker" | "signer";

/**
 * URL database per aplikasi (F4, Tahap 10): API_DATABASE_URL / WORKER_DATABASE_URL /
 * SIGNER_DATABASE_URL (role Postgres terbatas). Kosong → DATABASE_URL (kompatibilitas; satu role).
 * Migrasi selalu memakai DATABASE_URL (role pemilik).
 */
export function appDatabaseUrl(app: AppRole, env: NodeJS.ProcessEnv = process.env): string {
  return (
    env[`${app.toUpperCase()}_DATABASE_URL`]?.trim() || env.DATABASE_URL || DEFAULT_DATABASE_URL
  );
}

export function createPrismaClient(databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL) {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}

export type Db = PrismaClient;
export type DbTx = Prisma.TransactionClient;

export * from "./trade-ledger";
export * from "./economic-ledger";
export * from "./economic-health";
export * from "./system-status";
export * from "./quote-assets";
