-- D9 revisi: identitas utama = wallet (Sign-In With Solana); akun X opsional.

-- Baris dari sebelum perubahan ini (hanya ada di database development) belum punya wallet.
-- Diberi placeholder `legacy:<id>` yang bukan alamat Solana valid, sehingga tidak pernah
-- bisa dipakai sign-in. Akun X lama dianggap sudah tertaut sejak dibuat.
UPDATE "users" SET "wallet" = 'legacy:' || "id" WHERE "wallet" IS NULL;

ALTER TABLE "users" ADD COLUMN "xLinkedAt" TIMESTAMPTZ(3),
ALTER COLUMN "xUserId" DROP NOT NULL,
ALTER COLUMN "xHandle" DROP NOT NULL,
ALTER COLUMN "wallet" SET NOT NULL;

UPDATE "users" SET "xLinkedAt" = "createdAt" WHERE "xUserId" IS NOT NULL;
