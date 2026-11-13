-- Katalog quote mint di luar registri: simbol & desimal pair StonkFun selain SOL (BUILD_PLAN §7q).
CREATE TABLE "quote_assets" (
    "mint" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,
    "raiseRaw" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quote_assets_pkey" PRIMARY KEY ("mint")
);

-- Hanya worker yang menulis (sesudah verifikasi on-chain); API & signer hanya membaca.
GRANT SELECT ON "quote_assets" TO "liftoff_api", "liftoff_worker", "liftoff_signer";
GRANT INSERT, UPDATE ON "quote_assets" TO "liftoff_worker";
