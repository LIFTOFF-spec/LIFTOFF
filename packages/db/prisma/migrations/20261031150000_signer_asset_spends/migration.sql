-- Tahap 10 (F3): keluaran aset per mint dari akun token milik master untuk setiap tanda tangan,
-- diukur signer dari simulasi. Batas absolut per aset per 24 jam dihitung dari kolom ini.
ALTER TABLE "signer_spends" ADD COLUMN "assets" JSONB NOT NULL DEFAULT '{}';
