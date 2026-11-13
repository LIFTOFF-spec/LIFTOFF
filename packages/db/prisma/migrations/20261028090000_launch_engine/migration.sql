-- Tahap 4: signer service & launch engine.

-- Mint launch diturunkan signer per job (sama untuk semua pengiriman ulang → tidak ada launch ganda).
ALTER TABLE "launch_jobs" ADD COLUMN "mintAddress" TEXT,
ADD COLUMN "poolAddress" TEXT,
ADD COLUMN "createSignature" TEXT,
ADD COLUMN "submissionCount" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "launch_jobs_mintAddress_key" ON "launch_jobs"("mintAddress");

ALTER TABLE "transactions" ADD COLUMN "lastValidBlockHeight" BIGINT,
ADD COLUMN "sendMode" TEXT,
ADD COLUMN "bundleId" TEXT;

CREATE TYPE "DepositStatus" AS ENUM ('received', 'refund_pending', 'refunded', 'kept');

CREATE TABLE "launch_deposits" (
    "id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "depositSignature" TEXT NOT NULL,
    "payer" TEXT NOT NULL,
    "lamports" DECIMAL(40,0) NOT NULL,
    "status" "DepositStatus" NOT NULL DEFAULT 'received',
    "refundSignature" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "launch_deposits_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "launch_deposits_lamports_positive" CHECK ("lamports" > 0)
);
CREATE UNIQUE INDEX "launch_deposits_jobId_key" ON "launch_deposits"("jobId");
CREATE UNIQUE INDEX "launch_deposits_depositSignature_key" ON "launch_deposits"("depositSignature");
CREATE UNIQUE INDEX "launch_deposits_refundSignature_key" ON "launch_deposits"("refundSignature");
ALTER TABLE "launch_deposits" ADD CONSTRAINT "launch_deposits_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "launch_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "signer_spends" (
    "id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "jobId" UUID,
    "signature" TEXT NOT NULL,
    "lamports" DECIMAL(40,0) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signer_spends_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "signer_spends_lamports_nonnegative" CHECK ("lamports" >= 0)
);
CREATE UNIQUE INDEX "signer_spends_signature_key" ON "signer_spends"("signature");
CREATE INDEX "signer_spends_createdAt_idx" ON "signer_spends"("createdAt");

CREATE TABLE "system_flags" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "system_flags_pkey" PRIMARY KEY ("key")
);
