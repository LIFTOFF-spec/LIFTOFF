-- Tahap 9: ikat setiap tanda tangan signer ke operasinya (launch job / economic_ops) + blockhash,
-- agar signer menolak tanda tangan kedua selama transaksi pertama masih bisa mendarat.
ALTER TABLE "signer_spends" ADD COLUMN "opId" UUID;
ALTER TABLE "signer_spends" ADD COLUMN "blockhash" TEXT;

CREATE INDEX "signer_spends_purpose_jobId_idx" ON "signer_spends"("purpose", "jobId");
CREATE INDEX "signer_spends_opId_idx" ON "signer_spends"("opId");
