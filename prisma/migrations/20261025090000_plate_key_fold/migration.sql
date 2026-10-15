-- ============================================================================
-- Emergencies and gate services (ADR 0047): the plate key folds the Arabic
-- letter variants a keyboard gives for one letter.
--
-- ADR 0045 keyed a plate by dropping its spaces and reading Arabic-Indic
-- digits as Western ones. A guard typing "ا" for a sticker that reads "أ",
-- or "ي" for "ى", missed the car. The key now also reads أ/إ/آ as ا, ى as ي
-- and ة as ه, on every table that keys a plate. The application computes
-- the same key from the same two strings (src/core/common/vehicle-plate.ts,
-- PLATE_FOLD_FROM and PLATE_FOLD_TO); a test feeds both the same plates.
--
-- One active permit per plate in a compound (vehicles_one_active_plate): two
-- active vehicles whose plates differ only by these letters would become one
-- key. The migration then stops before changing anything and says so; the
-- management voids one of the permits (removes or edits the vehicle) and the
-- deployment runs again. Nothing is chosen for them.
-- ============================================================================

DO $$
DECLARE
  t record;
  n integer;
  total integer := 0;
BEGIN
  -- FORCE RLS applies to the migrator too: one compound at a time.
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    SELECT count(*) INTO n FROM (
      SELECT 1
        FROM "vehicles"
       WHERE "status" = 'active'
       GROUP BY "tenant_id", translate(replace("plate", ' ', ''),
                          '٠١٢٣٤٥٦٧٨٩أإآىة', '0123456789ااايه')
      HAVING count(*) > 1
    ) AS clash;
    total := total + n;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  IF total > 0 THEN
    RAISE EXCEPTION 'plate_key_fold: % plate(s) have two active permits once أ/إ/آ, ى and ة are folded; void one permit of each and deploy again (ADR 0047)', total
      USING ERRCODE = 'unique_violation';
  END IF;
END $$;

-- PostgreSQL 17: a new expression for a stored generated column rewrites the
-- table and its indexes, without firing row triggers.
ALTER TABLE "visitor_details" ALTER COLUMN "plate_key" SET EXPRESSION AS (
  translate(replace("vehicle_plate", ' ', ''), '٠١٢٣٤٥٦٧٨٩أإآىة', '0123456789ااايه')
);
ALTER TABLE "vehicles" ALTER COLUMN "plate_key" SET EXPRESSION AS (
  translate(replace("plate", ' ', ''), '٠١٢٣٤٥٦٧٨٩أإآىة', '0123456789ااايه')
);
ALTER TABLE "vehicle_fines" ALTER COLUMN "plate_key" SET EXPRESSION AS (
  translate(replace("plate", ' ', ''), '٠١٢٣٤٥٦٧٨٩أإآىة', '0123456789ااايه')
);
ALTER TABLE "parking_reports" ALTER COLUMN "plate_key" SET EXPRESSION AS (
  translate(replace("plate", ' ', ''), '٠١٢٣٤٥٦٧٨٩أإآىة', '0123456789ااايه')
);
