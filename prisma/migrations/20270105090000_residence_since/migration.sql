-- ============================================================================
-- R11c-1a (ADR 0069): since when an occupancy has lived in its unit.
--
-- A household reads its unit's consumption over its own tenure only, never
-- a household's before it (ADR 0066, 0069). `resides` changed without a
-- time on the row, so the tenure could not be told: an owner who moved back
-- in after a tenant would have read the tenant's use. `resides_since` is
-- that time, kept by the database:
--   * set to `started_at` when a residing occupancy is inserted without one
--     — or to its source's when it is a tenant's conversion to owner and
--     both reside, so a household that bought its unit keeps its tenure;
--   * set to now() when `resides` turns true, cleared when it turns false;
--   * present exactly while the occupancy resides (CHECK).
-- ============================================================================

ALTER TABLE "unit_occupancies" ADD COLUMN "resides_since" TIMESTAMPTZ(3);

CREATE FUNCTION unit_occupancy_resides_since() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  source_since TIMESTAMPTZ(3);
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT NEW."resides" THEN
      NEW."resides_since" := NULL;
    ELSIF NEW."resides_since" IS NULL THEN
      IF NEW."converted_from_id" IS NOT NULL THEN
        SELECT o."resides_since" INTO source_since
          FROM "unit_occupancies" o
         WHERE o."tenant_id" = NEW."tenant_id"
           AND o."id" = NEW."converted_from_id";
      END IF;
      NEW."resides_since" := COALESCE(source_since, NEW."started_at");
    END IF;
  ELSIF NEW."resides" IS DISTINCT FROM OLD."resides" THEN
    NEW."resides_since" := CASE WHEN NEW."resides" THEN now() END;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER unit_occupancies_resides_since
  BEFORE INSERT OR UPDATE ON "unit_occupancies"
  FOR EACH ROW EXECUTE FUNCTION unit_occupancy_resides_since();

-- Backfill one compound at a time (FORCE RLS applies to the migrator): a
-- residing occupancy has lived there since it started, a converted owner's
-- since its tenant row did. Sources first, so a conversion reads its
-- source's value.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    UPDATE "unit_occupancies" SET "resides_since" = "started_at"
     WHERE "resides" AND "converted_from_id" IS NULL;
    UPDATE "unit_occupancies" o
       SET "resides_since" = COALESCE(s."resides_since", o."started_at")
      FROM "unit_occupancies" s
     WHERE o."resides" AND o."converted_from_id" IS NOT NULL
       AND s."tenant_id" = o."tenant_id" AND s."id" = o."converted_from_id";
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

ALTER TABLE "unit_occupancies" ADD CONSTRAINT "unit_occupancies_resides_since_matches"
  CHECK ("resides" = ("resides_since" IS NOT NULL));
