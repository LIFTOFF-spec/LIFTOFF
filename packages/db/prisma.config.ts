import { defineConfig } from "prisma/config";

try {
  process.loadEnvFile(new URL("../../.env", import.meta.url));
} catch {
  // .env opsional; DATABASE_URL bisa datang dari environment.
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // Default sama dengan docker-compose.yml (kredensial lokal, bukan secret).
    url: process.env.DATABASE_URL ?? "postgresql://liftoff:liftoff@localhost:5432/liftoff",
  },
});
