-- Tahap 5: sumber fee di fee_ledger. Referral (share fee LaunchLab) dibayar langsung per trade
-- ke wallet LIFTOFF, terpisah dari platform fee yang masuk vault agregat (Tahap 1).
CREATE TYPE "FeeSource" AS ENUM ('platform_vault', 'referral');

ALTER TABLE "fee_ledger" ADD COLUMN "source" "FeeSource" NOT NULL DEFAULT 'platform_vault';

-- Satu transaksi trade = paling banyak satu entri `received` per sumber (idempotensi pencatatan).
CREATE UNIQUE INDEX "fee_ledger_received_once"
  ON "fee_ledger" ("sourceSignature", "source")
  WHERE "entryType" = 'received';
