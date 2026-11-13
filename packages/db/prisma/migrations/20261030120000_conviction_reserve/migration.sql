-- Tahap 8: Conviction Reserve activation (Spec §11–14, §20C).
--
-- 1. Opsi D dihapus (D5, keputusan pemilik 2026-10-29): nilai enum `expired_buyback` (reserve_ledger)
--    dan `reserve_expired` (burn_ledger) dibuang. Ledger append-only: tidak ada baris yang dihapus —
--    migrasi berhenti bila masih ada entri dengan nilai itu (devnet: 0 baris).
-- 2. Operasi reserve di economic_ops: `reserve_fund` (pindah dana reserve dari ATA quote master ke
--    akun kustodi per token) dan `reserve_deploy` (swap sebagian → add-liquidity ke pool CPMM token
--    itu → burn LP, satu transaksi atomik).
-- 3. `reserve_vaults` (alamat kustodi per token) dan `reserve_deployments` (append-only, Spec §11
--    Phase 5: bukti publik per deployment).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "reserve_ledger" WHERE "entryType"::text = 'expired_buyback')
     OR EXISTS (SELECT 1 FROM "burn_ledger" WHERE "source"::text = 'reserve_expired') THEN
    RAISE EXCEPTION 'masih ada entri Opsi D; tidak bisa dihapus dari ledger append-only';
  END IF;
END $$;

ALTER TABLE "reserve_ledger" DROP CONSTRAINT "reserve_ledger_amount_sign";
ALTER TYPE "ReserveEntryType" RENAME TO "ReserveEntryType_old";
CREATE TYPE "ReserveEntryType" AS ENUM ('contribution', 'deployment', 'correction');
ALTER TABLE "reserve_ledger"
  ALTER COLUMN "entryType" TYPE "ReserveEntryType" USING ("entryType"::text::"ReserveEntryType");
DROP TYPE "ReserveEntryType_old";
-- `deployment` dicatat positif (jumlah yang keluar dari reserve); hanya `correction` boleh negatif.
ALTER TABLE "reserve_ledger"
  ADD CONSTRAINT "reserve_ledger_amount_sign" CHECK ("amount" >= 0 OR "entryType" = 'correction');

ALTER TYPE "BurnSource" RENAME TO "BurnSource_old";
CREATE TYPE "BurnSource" AS ENUM ('buyback');
ALTER TABLE "burn_ledger" ALTER COLUMN "source" DROP DEFAULT;
ALTER TABLE "burn_ledger"
  ALTER COLUMN "source" TYPE "BurnSource" USING ("source"::text::"BurnSource");
ALTER TABLE "burn_ledger" ALTER COLUMN "source" SET DEFAULT 'buyback';
DROP TYPE "BurnSource_old";

ALTER TYPE "EconomicOpKind" ADD VALUE 'reserve_fund';
ALTER TYPE "EconomicOpKind" ADD VALUE 'reserve_deploy';

-- Akun kustodi terpisah per token (MVP Spec §13 "segregated custody accounts"): akun token SPL
-- dengan alamat deterministik createWithSeed(master, seed, Token Program) — siapa pun bisa
-- menurunkan ulang alamatnya. Sisi quote dibuat saat reserve pertama dipindahkan; sisi token saat
-- deployment pertama.
CREATE TABLE "reserve_vaults" (
  "tokenMint" TEXT NOT NULL,
  "quoteMint" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'segregated_custody',
  "quoteAccount" TEXT NOT NULL,
  "quoteSeed" TEXT NOT NULL,
  "tokenAccount" TEXT NOT NULL,
  "tokenSeed" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reserve_vaults_pkey" PRIMARY KEY ("tokenMint")
);
CREATE UNIQUE INDEX "reserve_vaults_quoteAccount_key" ON "reserve_vaults"("quoteAccount");
CREATE UNIQUE INDEX "reserve_vaults_tokenAccount_key" ON "reserve_vaults"("tokenAccount");

CREATE TABLE "reserve_deployments" (
  "id" UUID NOT NULL,
  "opId" UUID NOT NULL,
  "tokenMint" TEXT NOT NULL,
  "quoteMint" TEXT NOT NULL,
  "pool" TEXT NOT NULL,
  "lpMint" TEXT NOT NULL,
  "vaultQuoteAccount" TEXT NOT NULL,
  "vaultTokenAccount" TEXT NOT NULL,
  "reserveBeforeRaw" DECIMAL(40, 0) NOT NULL,
  "quoteDeployedRaw" DECIMAL(40, 0) NOT NULL,
  "swapInRaw" DECIMAL(40, 0) NOT NULL,
  "tokenBoughtRaw" DECIMAL(40, 0) NOT NULL,
  "quoteAddedRaw" DECIMAL(40, 0) NOT NULL,
  "tokenAddedRaw" DECIMAL(40, 0) NOT NULL,
  "lpMintedRaw" DECIMAL(40, 0) NOT NULL,
  "lpBurnedRaw" DECIMAL(40, 0) NOT NULL,
  "lockMethod" TEXT NOT NULL,
  "lockVerified" BOOLEAN NOT NULL,
  "remainingReserveRaw" DECIMAL(40, 0) NOT NULL,
  "tokenResidualRaw" DECIMAL(40, 0) NOT NULL,
  "signature" TEXT NOT NULL,
  "slot" BIGINT NOT NULL,
  "decisionId" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reserve_deployments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reserve_deployments_opId_fkey" FOREIGN KEY ("opId") REFERENCES "economic_ops"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "reserve_deployments_opId_key" ON "reserve_deployments"("opId");
CREATE UNIQUE INDEX "reserve_deployments_signature_key" ON "reserve_deployments"("signature");
CREATE INDEX "reserve_deployments_tokenMint_createdAt_idx" ON "reserve_deployments"("tokenMint", "createdAt");

CREATE TRIGGER "reserve_deployments_append_only" BEFORE UPDATE OR DELETE ON "reserve_deployments"
  FOR EACH ROW EXECUTE FUNCTION "liftoff_forbid_mutation"();
CREATE TRIGGER "reserve_deployments_no_truncate" BEFORE TRUNCATE ON "reserve_deployments"
  FOR EACH STATEMENT EXECUTE FUNCTION "liftoff_forbid_mutation"();
CREATE TRIGGER "reserve_vaults_no_delete" BEFORE DELETE OR TRUNCATE ON "reserve_vaults"
  FOR EACH STATEMENT EXECUTE FUNCTION "liftoff_forbid_mutation"();

-- Satu deployment per token per operasi; entri reserve_ledger `deployment` unik per signature.
CREATE UNIQUE INDEX "reserve_ledger_deployment_once"
  ON "reserve_ledger" ("txSignature", "tokenMint")
  WHERE "entryType" = 'deployment';
