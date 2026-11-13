-- Penyelarasan dengan Spec (docs/SPEC_LIFT.md), 2026-10-29.

-- §9–10: creator fee (curve LaunchLab & CPMM) ke master wallet = sumber dana 80/20.
ALTER TYPE "FeeSource" ADD VALUE IF NOT EXISTS 'creator_fee';

-- §7: ticker berulang TIDAK otomatis dianggap penipuan → klaim ticker aktif tidak lagi unik.
-- Ticker sama kini menjadi indikator risiko (Medium), dinilai bersama indikator lain.
DROP INDEX IF EXISTS "ticker_claims_active_unique";
CREATE INDEX IF NOT EXISTS "ticker_claims_active_idx"
  ON "ticker_claims" ("tickerNormalized")
  WHERE "status" = 'active';

-- §7: nama & tautan sosial ternormalisasi untuk deteksi duplikasi, plus hasil klasifikasi risiko.
CREATE TYPE "RiskLevel" AS ENUM ('low', 'medium', 'high');
ALTER TABLE "tokens"
  ADD COLUMN "nameNormalized" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "xNormalized" TEXT,
  ADD COLUMN "websiteNormalized" TEXT,
  ADD COLUMN "telegramNormalized" TEXT,
  ADD COLUMN "riskLevel" "RiskLevel" NOT NULL DEFAULT 'low',
  ADD COLUMN "riskReport" JSONB NOT NULL DEFAULT '{}';
CREATE INDEX "tokens_nameNormalized_idx" ON "tokens" ("nameNormalized");
CREATE INDEX "tokens_xNormalized_idx" ON "tokens" ("xNormalized");
CREATE INDEX "tokens_websiteNormalized_idx" ON "tokens" ("websiteNormalized");
CREATE INDEX "tokens_telegramNormalized_idx" ON "tokens" ("telegramNormalized");

-- §4: sidik jari config StonkFun saat validasi; worker menolak launch jika berubah.
ALTER TABLE "launch_jobs" ADD COLUMN "configFingerprint" TEXT;

-- §7: banding launch High-risk, ditinjau pemilik (admin allowlist wallet via SIWS).
CREATE TYPE "AppealStatus" AS ENUM ('pending', 'approved', 'rejected', 'used');
CREATE TABLE "launch_appeals" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "status" "AppealStatus" NOT NULL DEFAULT 'pending',
  "input" JSONB NOT NULL,
  "inputHash" TEXT NOT NULL,
  "risk" JSONB NOT NULL,
  "message" TEXT NOT NULL,
  "reviewNote" TEXT,
  "reviewedBy" TEXT,
  "reviewedAt" TIMESTAMPTZ(3),
  "usedByJobId" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "launch_appeals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "launch_appeals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "launch_appeals_usedByJobId_key" ON "launch_appeals" ("usedByJobId");
CREATE INDEX "launch_appeals_status_createdAt_idx" ON "launch_appeals" ("status", "createdAt");
CREATE INDEX "launch_appeals_userId_inputHash_idx" ON "launch_appeals" ("userId", "inputHash");
-- Satu banding terbuka (pending/approved) per user per input.
CREATE UNIQUE INDEX "launch_appeals_open_unique"
  ON "launch_appeals" ("userId", "inputHash")
  WHERE "status" IN ('pending', 'approved');

-- §16 Section 4 & §17 statistik: receipt trade yang terbukti on-chain (dibaca dari event program).
CREATE TABLE "trade_receipts" (
  "signature" TEXT NOT NULL,
  "tokenMint" TEXT NOT NULL,
  "wallet" TEXT NOT NULL,
  "side" TEXT NOT NULL,
  "route" TEXT NOT NULL,
  "quoteMint" TEXT NOT NULL,
  "amountToken" DECIMAL(40,0) NOT NULL,
  "amountQuote" DECIMAL(40,0) NOT NULL,
  "creatorFee" DECIMAL(40,0) NOT NULL,
  "creatorFeeMint" TEXT,
  "slot" BIGINT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "trade_receipts_pkey" PRIMARY KEY ("signature")
);
CREATE INDEX "trade_receipts_tokenMint_createdAt_idx" ON "trade_receipts" ("tokenMint", "createdAt");