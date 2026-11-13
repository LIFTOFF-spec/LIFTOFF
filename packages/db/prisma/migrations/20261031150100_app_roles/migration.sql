-- Tahap 10 (F4): role Postgres terpisah per aplikasi. Migrasi dijalankan role pemilik (DATABASE_URL);
-- aplikasi login dengan role di bawah (API_DATABASE_URL / WORKER_DATABASE_URL / SIGNER_DATABASE_URL).
-- Role dibuat NOLOGIN; `pnpm --filter @liftoff/db roles` memberi LOGIN + password dari env.
-- Role berlaku untuk seluruh cluster Postgres, jadi pembuatannya idempoten.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liftoff_api') THEN
    CREATE ROLE "liftoff_api" NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liftoff_worker') THEN
    CREATE ROLE "liftoff_worker" NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liftoff_signer') THEN
    CREATE ROLE "liftoff_signer" NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO "liftoff_api", "liftoff_worker", "liftoff_signer";

-- Mulai dari nol (migrasi bisa dijalankan di DB yang role-nya sudah punya hak lain).
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "liftoff_api", "liftoff_worker", "liftoff_signer";

-- Semua aplikasi boleh MEMBACA semua tabel aplikasi (signer menghitung ulang budget dari ledger).
GRANT SELECT ON ALL TABLES IN SCHEMA public TO "liftoff_api", "liftoff_worker", "liftoff_signer";
REVOKE ALL ON "_prisma_migrations" FROM "liftoff_api", "liftoff_worker", "liftoff_signer";

-- API publik: data pengguna, launch, banding, receipt trade. TIDAK menulis economic_ops, ledger
-- ekonomi (fee/burn/reserve, fee_claim_items, fee_reconciliations), reserve_*, signer_spends,
-- system_flags. Tidak ada DELETE.
GRANT INSERT, UPDATE ON
  "users", "tokens", "ticker_claims", "x_account_claims", "launch_jobs", "launch_deposits",
  "launch_appeals", "trade_receipts"
TO "liftoff_api";
GRANT INSERT ON "transactions", "audit_events" TO "liftoff_api";

-- Worker (launch, indexer, economic, reserve, monitor): state operasi + ledger append-only
-- (INSERT saja; trigger juga menolak UPDATE/DELETE). TIDAK menulis signer_spends (batas harian
-- signer) dan system_flags (pause). Tidak ada DELETE.
GRANT INSERT, UPDATE ON
  "tokens", "ticker_claims", "x_account_claims", "launch_jobs", "launch_deposits", "transactions",
  "economic_ops", "worker_heartbeats", "trade_receipts", "token_markets", "indexer_checkpoints",
  "token_graduations", "reserve_vaults", "reserve_deployments", "reserve_decisions"
TO "liftoff_worker";
GRANT INSERT ON
  "fee_ledger", "burn_ledger", "reserve_ledger", "fee_claim_items", "fee_reconciliations",
  "audit_events"
TO "liftoff_worker";

-- Signer: read-only kecuali catatan tanda tangan, audit, dan flag pause.
GRANT INSERT ON "signer_spends", "audit_events" TO "liftoff_signer";
GRANT INSERT, UPDATE ON "system_flags" TO "liftoff_signer";

-- Tabel baru dari migrasi berikutnya otomatis bisa DIBACA; hak tulis wajib ditambahkan eksplisit.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO "liftoff_api", "liftoff_worker", "liftoff_signer";
