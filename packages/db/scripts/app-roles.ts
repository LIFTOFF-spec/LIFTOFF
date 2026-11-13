// F4 (Tahap 10): aktifkan login role Postgres per aplikasi dari URL di .env.
//   pnpm --filter @liftoff/db roles
// Dijalankan dengan DATABASE_URL (role pemilik / migrasi) SETELAH `migrate deploy` (migrasi
// 20261031150100_app_roles membuat role grup liftoff_api / liftoff_worker / liftoff_signer + hak).
// Untuk tiap API_DATABASE_URL / WORKER_DATABASE_URL / SIGNER_DATABASE_URL yang diisi: user di URL
// diberi LOGIN + password dari URL. Bila user ≠ nama role grup, user dibuat dan dijadikan anggota
// grup. Password tidak pernah dicetak.
import pg from "pg";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // .env opsional
}

const APPS = [
  ["API_DATABASE_URL", "liftoff_api"],
  ["WORKER_DATABASE_URL", "liftoff_worker"],
  ["SIGNER_DATABASE_URL", "liftoff_signer"],
] as const;

const owner = new pg.Client({
  connectionString:
    process.env.DATABASE_URL ?? "postgresql://liftoff:liftoff@localhost:5432/liftoff",
});
await owner.connect();
try {
  for (const [name, group] of APPS) {
    const raw = process.env[name]?.trim();
    if (!raw) {
      console.warn(`${name} kosong: dilewati (aplikasi memakai DATABASE_URL)`);
      continue;
    }
    const url = new URL(raw);
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    if (!user || password.length < 12)
      throw new Error(`${name}: user + password ≥ 12 karakter wajib`);
    const exists = await owner.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [user]);
    const id = owner.escapeIdentifier(user);
    const pw = owner.escapeLiteral(password);
    await owner.query(
      exists.rowCount
        ? `ALTER ROLE ${id} WITH LOGIN PASSWORD ${pw}`
        : `CREATE ROLE ${id} WITH LOGIN PASSWORD ${pw}`,
    );
    if (user !== group) await owner.query(`GRANT ${owner.escapeIdentifier(group)} TO ${id}`);
    console.warn(`${name}: role ${user} (grup ${group}) siap`);
  }
} finally {
  await owner.end();
}
