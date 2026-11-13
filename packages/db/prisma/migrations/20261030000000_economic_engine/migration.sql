-- Tahap 7: economic engine — claim creator fee, rekonsiliasi, buyback & burn (Spec §9, §13, §20A–B).

CREATE TYPE "EconomicOpKind" AS ENUM ('claim_curve', 'claim_cpmm', 'buyback', 'burn');
CREATE TYPE "EconomicOpStatus" AS ENUM ('pending', 'signed', 'submitted', 'confirmed', 'failed', 'expired');
CREATE TYPE "FeeBucket" AS ENUM ('received', 'buyback', 'reserve');

-- Satu baris per transaksi economic engine. Write-ahead: signature + transaksi bertanda tangan
-- disimpan SEBELUM dikirim, sehingga restart tidak pernah membangun transaksi kedua untuk operasi
-- yang mungkin sudah mendarat.
CREATE TABLE "economic_ops" (
  "id" UUID NOT NULL,
  "kind" "EconomicOpKind" NOT NULL,
  "status" "EconomicOpStatus" NOT NULL DEFAULT 'pending',
  "idempotencyKey" TEXT NOT NULL,
  "tokenMint" TEXT,
  "assetMint" TEXT NOT NULL,
  "target" TEXT NOT NULL,
  "amountIn" DECIMAL(40, 0),
  "minOut" DECIMAL(40, 0),
  "amountOut" DECIMAL(40, 0),
  "parentOpId" UUID,
  "signature" TEXT,
  "signedTx" TEXT,
  "lastValidBlockHeight" BIGINT,
  "slot" BIGINT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "details" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  "confirmedAt" TIMESTAMPTZ(3),
  CONSTRAINT "economic_ops_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "economic_ops_parentOpId_fkey" FOREIGN KEY ("parentOpId") REFERENCES "economic_ops"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "economic_ops_idempotencyKey_key" ON "economic_ops"("idempotencyKey");
CREATE UNIQUE INDEX "economic_ops_signature_key" ON "economic_ops"("signature");
CREATE INDEX "economic_ops_tokenMint_kind_idx" ON "economic_ops"("tokenMint", "kind");
CREATE INDEX "economic_ops_status_idx" ON "economic_ops"("status");
-- Anti-duplikasi: paling banyak satu operasi aktif per (jenis, target) — dua worker yang berjalan
-- bersamaan tidak bisa sama-sama membuat claim/buyback untuk target yang sama.
CREATE UNIQUE INDEX "economic_ops_one_active"
  ON "economic_ops" ("kind", "target")
  WHERE "status" IN ('pending', 'signed', 'submitted');
-- Satu buyback hanya dibakar sekali (burn gagal/kedaluwarsa boleh diulang).
CREATE UNIQUE INDEX "economic_ops_burn_once"
  ON "economic_ops" ("parentOpId")
  WHERE "kind" = 'burn' AND "status" IN ('pending', 'signed', 'submitted', 'confirmed');
ALTER TABLE "economic_ops"
  ADD CONSTRAINT "economic_ops_amounts_sign"
  CHECK (coalesce("amountIn", 0) >= 0 AND coalesce("minOut", 0) >= 0 AND coalesce("amountOut", 0) >= 0);

-- Operasi yang sudah confirmed final: status dan nominalnya tidak boleh berubah lagi.
CREATE FUNCTION "liftoff_economic_op_final"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'confirmed' AND (
       NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."amountIn" IS DISTINCT FROM OLD."amountIn"
    OR NEW."amountOut" IS DISTINCT FROM OLD."amountOut"
    OR NEW."signature" IS DISTINCT FROM OLD."signature"
    OR NEW."tokenMint" IS DISTINCT FROM OLD."tokenMint"
    OR NEW."assetMint" IS DISTINCT FROM OLD."assetMint") THEN
    RAISE EXCEPTION 'economic_ops %: operasi confirmed bersifat final', OLD."id" USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "economic_ops_final" BEFORE UPDATE ON "economic_ops"
  FOR EACH ROW EXECUTE FUNCTION "liftoff_economic_op_final"();
CREATE TRIGGER "economic_ops_no_delete" BEFORE DELETE OR TRUNCATE ON "economic_ops"
  FOR EACH STATEMENT EXECUTE FUNCTION "liftoff_forbid_mutation"();

-- Entri `received` creator fee yang tercakup claim tertentu (setiap entri hanya sekali).
CREATE TABLE "fee_claim_items" (
  "feeLedgerId" UUID NOT NULL,
  "claimOpId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fee_claim_items_pkey" PRIMARY KEY ("feeLedgerId"),
  CONSTRAINT "fee_claim_items_feeLedgerId_fkey" FOREIGN KEY ("feeLedgerId") REFERENCES "fee_ledger"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "fee_claim_items_claimOpId_fkey" FOREIGN KEY ("claimOpId") REFERENCES "economic_ops"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "fee_claim_items_claimOpId_idx" ON "fee_claim_items"("claimOpId");

-- Hasil rekonsiliasi per (claim, asset): Δ yang benar-benar di-claim vs alokasi ledger.
CREATE TABLE "fee_reconciliations" (
  "id" UUID NOT NULL,
  "claimOpId" UUID NOT NULL,
  "assetMint" TEXT NOT NULL,
  "claimedRaw" DECIMAL(40, 0) NOT NULL,
  "ledgerRaw" DECIMAL(40, 0) NOT NULL,
  "differenceRaw" DECIMAL(40, 0) NOT NULL,
  "unattributedRaw" DECIMAL(40, 0) NOT NULL DEFAULT 0,
  "status" "Attribution" NOT NULL,
  "tokens" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fee_reconciliations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fee_reconciliations_claimOpId_fkey" FOREIGN KEY ("claimOpId") REFERENCES "economic_ops"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "fee_reconciliations_once" ON "fee_reconciliations"("claimOpId", "assetMint");

-- Koreksi fee_ledger dari rekonsiliasi: bagian mana yang dikoreksi + claim asalnya.
ALTER TABLE "fee_ledger"
  ADD COLUMN "bucket" "FeeBucket",
  ADD COLUMN "claimOpId" UUID;
CREATE INDEX "fee_ledger_claimOpId_idx" ON "fee_ledger"("claimOpId");

-- Status worker untuk alert (gagal berulang, saldo master rendah, selisih ledger).
CREATE TABLE "worker_heartbeats" (
  "name" TEXT NOT NULL,
  "lastRunAt" TIMESTAMPTZ(3) NOT NULL,
  "lastOkAt" TIMESTAMPTZ(3),
  "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "details" JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT "worker_heartbeats_pkey" PRIMARY KEY ("name")
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fee_claim_items', 'fee_reconciliations']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION "liftoff_forbid_mutation"()',
      t || '_append_only', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "liftoff_forbid_mutation"()',
      t || '_no_truncate', t);
  END LOOP;
END;
$$;

-- Lease sederhana per worker: satu proses aktif per siklus (proses kedua melewati siklus).
ALTER TABLE "worker_heartbeats" ADD COLUMN "leaseOwner" TEXT, ADD COLUMN "leaseUntil" TIMESTAMPTZ(3);
