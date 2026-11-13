-- Aturan DB yang tidak bisa dinyatakan di schema.prisma (Tahap 3).

-- P4: satu ticker ternormalisasi hanya boleh dimiliki satu klaim aktif. Dua launch yang
-- balapan untuk ticker yang sama (termasuk varian leetspeak/homoglyph, karena yang disimpan
-- adalah bentuk ternormalisasi) tidak bisa sama-sama menang.
CREATE UNIQUE INDEX "ticker_claims_active_unique"
  ON "ticker_claims" ("tickerNormalized")
  WHERE "status" = 'active';

-- D9: satu akun X = satu koin aktif.
CREATE UNIQUE INDEX "x_account_claims_active_unique"
  ON "x_account_claims" ("xUserId")
  WHERE "status" = 'active';

-- Nominal ledger tidak boleh negatif kecuali entri koreksi.
ALTER TABLE "fee_ledger"
  ADD CONSTRAINT "fee_ledger_amount_sign"
  CHECK ("amount" >= 0 OR "entryType" = 'correction');
ALTER TABLE "reserve_ledger"
  ADD CONSTRAINT "reserve_ledger_amount_sign"
  CHECK ("amount" >= 0 OR "entryType" = 'correction');
ALTER TABLE "burn_ledger"
  ADD CONSTRAINT "burn_ledger_amount_sign"
  CHECK ("amountBurned" >= 0 AND "amountSpent" >= 0);

-- Aturan #7: ledger append-only. UPDATE, DELETE, dan TRUNCATE ditolak oleh trigger.
CREATE FUNCTION "liftoff_forbid_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % pada tabel % tidak diizinkan; gunakan entri koreksi', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END;
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fee_ledger', 'burn_ledger', 'reserve_ledger', 'reserve_decisions', 'audit_events']
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
