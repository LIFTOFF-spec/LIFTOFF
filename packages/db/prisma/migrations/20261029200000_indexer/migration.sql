-- Tahap 6: indexer on-chain & graduation monitoring (Spec §14–17), 2026-10-29.

-- Receipt trade juga dicatat indexer (trade di luar UI LIFTOFF); harga per trade untuk chart.
ALTER TABLE "trade_receipts"
  ADD COLUMN "priceQuote" DECIMAL(65, 30),
  ADD COLUMN "blockTime" TIMESTAMPTZ(3),
  ADD COLUMN "recordedBy" TEXT NOT NULL DEFAULT 'api';

CREATE TYPE "MarketRoute" AS ENUM ('launchlab', 'migrating', 'cpmm');
CREATE TYPE "GraduationState" AS ENUM ('not_graduated', 'migrating', 'pool_pending', 'verified', 'failed');

CREATE TABLE "token_markets" (
  "tokenMint" TEXT NOT NULL,
  "route" "MarketRoute" NOT NULL,
  "launchPool" TEXT NOT NULL,
  "cpmmPool" TEXT,
  "curveStatus" INTEGER NOT NULL,
  "priceQuote" DECIMAL(65, 30),
  "supplyRaw" DECIMAL(40, 0) NOT NULL,
  "curveRaisedRaw" DECIMAL(40, 0) NOT NULL,
  "curveTargetRaw" DECIMAL(40, 0) NOT NULL,
  "liquidityQuoteRaw" DECIMAL(40, 0) NOT NULL,
  "holders" INTEGER,
  "holdersAt" TIMESTAMPTZ(3),
  "indexedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "token_markets_pkey" PRIMARY KEY ("tokenMint")
);

CREATE TABLE "indexer_checkpoints" (
  "address" TEXT NOT NULL,
  "tokenMint" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "lastSignature" TEXT,
  "lastSlot" BIGINT,
  "processed" INTEGER NOT NULL DEFAULT 0,
  "errorCount" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "indexer_checkpoints_pkey" PRIMARY KEY ("address")
);
CREATE INDEX "indexer_checkpoints_tokenMint_idx" ON "indexer_checkpoints" ("tokenMint");

CREATE TABLE "token_graduations" (
  "tokenMint" TEXT NOT NULL,
  "state" "GraduationState" NOT NULL,
  "launchPool" TEXT NOT NULL,
  "cpmmPool" TEXT,
  "migrateSignature" TEXT,
  "migratedAt" TIMESTAMPTZ(3),
  "lpMint" TEXT,
  "lpTotalRaw" DECIMAL(40, 0),
  "lpBurnedRaw" DECIMAL(40, 0),
  "lpLockedRaw" DECIMAL(40, 0),
  "lpFreeRaw" DECIMAL(40, 0),
  "addLiquiditySupported" BOOLEAN NOT NULL DEFAULT false,
  "reserveMonitoringActive" BOOLEAN NOT NULL DEFAULT false,
  "checks" JSONB NOT NULL DEFAULT '[]',
  "verifiedAt" TIMESTAMPTZ(3),
  "checkedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "token_graduations_pkey" PRIMARY KEY ("tokenMint")
);
