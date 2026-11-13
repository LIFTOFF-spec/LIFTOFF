-- CreateEnum
CREATE TYPE "LaunchStatus" AS ENUM ('validating', 'queued', 'submitting', 'confirming', 'live', 'failed', 'needs_reconciliation');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('active', 'released');

-- CreateEnum
CREATE TYPE "TxType" AS ENUM ('create', 'trade', 'claim_fee', 'buyback', 'burn', 'add_liquidity', 'lock_lp');

-- CreateEnum
CREATE TYPE "ConfirmationStatus" AS ENUM ('pending', 'processed', 'confirmed', 'finalized', 'failed');

-- CreateEnum
CREATE TYPE "FeeEntryType" AS ENUM ('received', 'allocated_buyback', 'allocated_reserve', 'allocated_treasury', 'correction');

-- CreateEnum
CREATE TYPE "Attribution" AS ENUM ('verified', 'estimated');

-- CreateEnum
CREATE TYPE "BurnSource" AS ENUM ('buyback', 'reserve_expired');

-- CreateEnum
CREATE TYPE "ReserveEntryType" AS ENUM ('contribution', 'deployment', 'expired_buyback', 'correction');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "xUserId" TEXT NOT NULL,
    "xHandle" TEXT NOT NULL,
    "wallet" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tokens" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "tickerNormalized" TEXT NOT NULL,
    "mint" TEXT,
    "imageUrl" TEXT,
    "imageHash" TEXT,
    "description" TEXT NOT NULL DEFAULT '',
    "links" JSONB NOT NULL DEFAULT '{}',
    "quoteMint" TEXT NOT NULL,
    "creatorUserId" UUID NOT NULL,
    "launchStatus" "LaunchStatus" NOT NULL DEFAULT 'validating',
    "graduatedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticker_claims" (
    "id" UUID NOT NULL,
    "tickerNormalized" TEXT NOT NULL,
    "tokenId" UUID NOT NULL,
    "status" "ClaimStatus" NOT NULL DEFAULT 'active',
    "expiresAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticker_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "x_account_claims" (
    "id" UUID NOT NULL,
    "xUserId" TEXT NOT NULL,
    "tokenId" UUID NOT NULL,
    "status" "ClaimStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "x_account_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "launch_jobs" (
    "id" UUID NOT NULL,
    "tokenId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" "LaunchStatus" NOT NULL DEFAULT 'queued',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "bundleId" TEXT,
    "timeline" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "launch_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "signature" TEXT NOT NULL,
    "jobId" UUID,
    "type" "TxType" NOT NULL,
    "confirmationStatus" "ConfirmationStatus" NOT NULL DEFAULT 'pending',
    "slot" BIGINT,
    "errorCode" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("signature")
);

-- CreateTable
CREATE TABLE "fee_ledger" (
    "id" UUID NOT NULL,
    "sourceSignature" TEXT NOT NULL,
    "tokenMint" TEXT NOT NULL,
    "amount" DECIMAL(40,0) NOT NULL,
    "assetMint" TEXT NOT NULL,
    "entryType" "FeeEntryType" NOT NULL,
    "attribution" "Attribution" NOT NULL,
    "relatedSignature" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "burn_ledger" (
    "id" UUID NOT NULL,
    "tokenMint" TEXT NOT NULL,
    "amountBurned" DECIMAL(40,0) NOT NULL,
    "amountSpent" DECIMAL(40,0) NOT NULL,
    "assetMint" TEXT NOT NULL,
    "source" "BurnSource" NOT NULL DEFAULT 'buyback',
    "buybackSignature" TEXT NOT NULL,
    "burnSignature" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "burn_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reserve_ledger" (
    "id" UUID NOT NULL,
    "tokenMint" TEXT NOT NULL,
    "entryType" "ReserveEntryType" NOT NULL,
    "amount" DECIMAL(40,0) NOT NULL,
    "assetMint" TEXT NOT NULL,
    "txSignature" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reserve_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reserve_config_overrides" (
    "tokenMint" TEXT NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reserve_config_overrides_pkey" PRIMARY KEY ("tokenMint")
);

-- CreateTable
CREATE TABLE "reserve_decisions" (
    "id" UUID NOT NULL,
    "tokenMint" TEXT NOT NULL,
    "allowed" BOOLEAN NOT NULL,
    "amount" DECIMAL(40,0) NOT NULL,
    "reasons" TEXT[],
    "inputSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reserve_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "requestId" TEXT,
    "txSignature" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_xUserId_key" ON "users"("xUserId");

-- CreateIndex
CREATE UNIQUE INDEX "users_wallet_key" ON "users"("wallet");

-- CreateIndex
CREATE UNIQUE INDEX "tokens_mint_key" ON "tokens"("mint");

-- CreateIndex
CREATE INDEX "tokens_tickerNormalized_idx" ON "tokens"("tickerNormalized");

-- CreateIndex
CREATE INDEX "tokens_createdAt_idx" ON "tokens"("createdAt");

-- CreateIndex
CREATE INDEX "tokens_quoteMint_idx" ON "tokens"("quoteMint");

-- CreateIndex
CREATE INDEX "ticker_claims_tokenId_idx" ON "ticker_claims"("tokenId");

-- CreateIndex
CREATE INDEX "x_account_claims_tokenId_idx" ON "x_account_claims"("tokenId");

-- CreateIndex
CREATE UNIQUE INDEX "launch_jobs_tokenId_key" ON "launch_jobs"("tokenId");

-- CreateIndex
CREATE UNIQUE INDEX "launch_jobs_idempotencyKey_key" ON "launch_jobs"("idempotencyKey");

-- CreateIndex
CREATE INDEX "launch_jobs_userId_createdAt_idx" ON "launch_jobs"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "launch_jobs_createdAt_idx" ON "launch_jobs"("createdAt");

-- CreateIndex
CREATE INDEX "transactions_jobId_idx" ON "transactions"("jobId");

-- CreateIndex
CREATE INDEX "fee_ledger_tokenMint_createdAt_idx" ON "fee_ledger"("tokenMint", "createdAt");

-- CreateIndex
CREATE INDEX "fee_ledger_sourceSignature_idx" ON "fee_ledger"("sourceSignature");

-- CreateIndex
CREATE UNIQUE INDEX "burn_ledger_burnSignature_key" ON "burn_ledger"("burnSignature");

-- CreateIndex
CREATE INDEX "burn_ledger_tokenMint_createdAt_idx" ON "burn_ledger"("tokenMint", "createdAt");

-- CreateIndex
CREATE INDEX "reserve_ledger_tokenMint_createdAt_idx" ON "reserve_ledger"("tokenMint", "createdAt");

-- CreateIndex
CREATE INDEX "reserve_decisions_tokenMint_createdAt_idx" ON "reserve_decisions"("tokenMint", "createdAt");

-- CreateIndex
CREATE INDEX "audit_events_action_createdAt_idx" ON "audit_events"("action", "createdAt");

-- AddForeignKey
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_creatorUserId_fkey" FOREIGN KEY ("creatorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticker_claims" ADD CONSTRAINT "ticker_claims_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "x_account_claims" ADD CONSTRAINT "x_account_claims_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "launch_jobs" ADD CONSTRAINT "launch_jobs_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "launch_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
