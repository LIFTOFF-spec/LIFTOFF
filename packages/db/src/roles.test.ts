/**
 * F4 (Tahap 10): role Postgres per aplikasi (migrasi 20261031150100_app_roles). Test berjalan
 * sebagai role pemilik lalu `SET LOCAL ROLE` untuk membuktikan hak yang benar-benar ditegakkan.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareTestDatabase } from "./testing";

let client: pg.Client;

beforeAll(async () => {
  client = new pg.Client({ connectionString: await prepareTestDatabase("liftoff_test_db") });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

type Role = "liftoff_api" | "liftoff_worker" | "liftoff_signer";

async function can(role: Role, table: string, privilege: string): Promise<boolean> {
  const res = await client.query<{ ok: boolean }>("SELECT has_table_privilege($1, $2, $3) AS ok", [
    role,
    `public."${table}"`,
    privilege,
  ]);
  return res.rows[0]!.ok;
}

/** Jalankan SQL sebagai role (transaksi selalu di-rollback); kembalikan kode error Postgres. */
async function as(role: Role, sql: string, params: unknown[] = []): Promise<string | null> {
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query(sql, params);
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "error";
  } finally {
    await client.query("ROLLBACK");
  }
}

const LEDGERS = [
  "fee_ledger",
  "burn_ledger",
  "reserve_ledger",
  "fee_claim_items",
  "fee_reconciliations",
];

describe("role Postgres per aplikasi (F4)", () => {
  it("semua role bisa membaca tabel aplikasi, tidak bisa membaca _prisma_migrations", async () => {
    for (const role of ["liftoff_api", "liftoff_worker", "liftoff_signer"] as const) {
      for (const t of ["economic_ops", "fee_ledger", "signer_spends", "tokens", "audit_events"]) {
        expect(await can(role, t, "SELECT"), `${role} SELECT ${t}`).toBe(true);
      }
      expect(await can(role, "_prisma_migrations", "SELECT")).toBe(false);
    }
  });

  it("katalog quote: hanya worker yang menulis, tidak ada yang menghapus, semua membaca", async () => {
    expect(await can("liftoff_worker", "quote_assets", "INSERT")).toBe(true);
    expect(await can("liftoff_worker", "quote_assets", "UPDATE")).toBe(true);
    expect(await can("liftoff_signer", "quote_assets", "INSERT")).toBe(false);
    for (const role of ["liftoff_api", "liftoff_worker", "liftoff_signer"] as const) {
      expect(await can(role, "quote_assets", "SELECT")).toBe(true);
      expect(await can(role, "quote_assets", "DELETE")).toBe(false);
    }
  });

  it("API publik tidak bisa menulis economic_ops, ledger ekonomi, reserve_*, signer_spends", async () => {
    for (const t of [
      "economic_ops",
      ...LEDGERS,
      "reserve_vaults",
      "reserve_deployments",
      "reserve_decisions",
      "reserve_config_overrides",
      "signer_spends",
      "system_flags",
      "quote_assets",
    ]) {
      for (const p of ["INSERT", "UPDATE", "DELETE"]) {
        expect(await can("liftoff_api", t, p), `api ${p} ${t}`).toBe(false);
      }
    }
    for (const t of ["users", "tokens", "launch_jobs", "launch_appeals", "trade_receipts"]) {
      expect(await can("liftoff_api", t, "INSERT"), `api INSERT ${t}`).toBe(true);
    }
    expect(
      await as(
        "liftoff_api",
        `INSERT INTO "economic_ops" ("id","kind","status","target","assetMint","idempotencyKey","updatedAt")
         VALUES (gen_random_uuid(),'buyback','pending','x','x','x',now())`,
      ),
    ).toBe("42501");
    expect(
      await as(
        "liftoff_api",
        `INSERT INTO "fee_ledger" ("id","sourceSignature","tokenMint","amount","assetMint","entryType","source","attribution")
         VALUES (gen_random_uuid(),'s','m',1,'a','received','creator_fee','verified')`,
      ),
    ).toBe("42501");
  });

  it("signer read-only kecuali signer_spends, audit_events, system_flags", async () => {
    for (const t of ["economic_ops", ...LEDGERS, "tokens", "launch_jobs", "launch_deposits"]) {
      for (const p of ["INSERT", "UPDATE", "DELETE"]) {
        expect(await can("liftoff_signer", t, p), `signer ${p} ${t}`).toBe(false);
      }
    }
    expect(await can("liftoff_signer", "signer_spends", "INSERT")).toBe(true);
    expect(await can("liftoff_signer", "signer_spends", "DELETE")).toBe(false);
    expect(await can("liftoff_signer", "signer_spends", "UPDATE")).toBe(false);
    expect(await can("liftoff_signer", "audit_events", "INSERT")).toBe(true);
    expect(await can("liftoff_signer", "system_flags", "UPDATE")).toBe(true);
    expect(
      await as(
        "liftoff_signer",
        `INSERT INTO "signer_spends" ("id","purpose","signature","lamports","assets")
         VALUES (gen_random_uuid(),'buyback',$1,5000,'{}')`,
        [`roles-test-${Date.now()}`],
      ),
    ).toBeNull();
    expect(await as("liftoff_signer", `UPDATE "economic_ops" SET "status" = 'failed'`)).toBe(
      "42501",
    );
    expect(await as("liftoff_signer", `DELETE FROM "signer_spends"`)).toBe("42501");
  });

  it("worker menulis state operasi + ledger (INSERT saja), tidak menyentuh batas signer", async () => {
    expect(await can("liftoff_worker", "economic_ops", "INSERT")).toBe(true);
    expect(await can("liftoff_worker", "economic_ops", "UPDATE")).toBe(true);
    for (const t of LEDGERS) {
      expect(await can("liftoff_worker", t, "INSERT"), `worker INSERT ${t}`).toBe(true);
      expect(await can("liftoff_worker", t, "UPDATE"), `worker UPDATE ${t}`).toBe(false);
      expect(await can("liftoff_worker", t, "DELETE"), `worker DELETE ${t}`).toBe(false);
    }
    for (const p of ["INSERT", "UPDATE", "DELETE"]) {
      expect(await can("liftoff_worker", "signer_spends", p)).toBe(false);
      expect(await can("liftoff_worker", "system_flags", p)).toBe(false);
    }
    expect(await as("liftoff_worker", `DELETE FROM "signer_spends"`)).toBe("42501");
  });
});
