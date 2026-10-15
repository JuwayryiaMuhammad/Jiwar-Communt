-- ============================================================================
-- Emergencies and gate services (ADR 0047): the compound's places.
--
-- Where a resident asks security to meet them, walk with them or look: a
-- gate, a phase, the clubhouse, the parking. Each compound starts with the
-- seven of the mobile contract, known by `key` so the app can name them in
-- its own words; the manager renames, orders, retires and adds their own
-- (no key). A place is never deleted: requests point at it. No personal
-- data here.
-- ============================================================================

CREATE TABLE "places" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT,
    "name_ar" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "places_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "places_tenant_id_id_key" ON "places"("tenant_id", "id");
-- One place per default key in a compound.
CREATE UNIQUE INDEX "places_key_key" ON "places"("tenant_id", "key")
  WHERE "key" IS NOT NULL;
-- Two places in service never share a name, in either language.
CREATE UNIQUE INDEX "places_active_name_en_key"
  ON "places"("tenant_id", lower("name_en")) WHERE "active";
CREATE UNIQUE INDEX "places_active_name_ar_key"
  ON "places"("tenant_id", "name_ar") WHERE "active";
CREATE INDEX "places_order_idx" ON "places"("tenant_id", "position", "id");
ALTER TABLE "places" ADD CONSTRAINT "places_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- REASON_CODES.placeKey; a unit test keeps the two in step.
ALTER TABLE "places" ADD CONSTRAINT "places_key"
  CHECK ("key" IS NULL
      OR "key" IN ('main_gate', 'north_gate', 'phase_a', 'phase_b', 'clubhouse', 'parking', 'other'));
ALTER TABLE "places" ADD CONSTRAINT "places_names_length"
  CHECK (char_length("name_ar") BETWEEN 1 AND 60 AND char_length("name_en") BETWEEN 1 AND 60);
ALTER TABLE "places" ADD CONSTRAINT "places_position_range"
  CHECK ("position" BETWEEN 0 AND 1000);

-- A place keeps its key: the app names a default place by it.
CREATE FUNCTION place_keeps_its_key() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."key" IS NOT DISTINCT FROM OLD."key"
     AND NEW."created_at" = OLD."created_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'places: a place keeps its key and is never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER places_keep_key
  BEFORE UPDATE OR DELETE ON "places"
  FOR EACH ROW EXECUTE FUNCTION place_keeps_its_key();
CREATE TRIGGER places_keep_key_truncate
  BEFORE TRUNCATE ON "places"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "places" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "places" TO jiwar_app;
ALTER TABLE "places" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "places" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "places"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ----------------------------------------------------------------------------
-- Existing compounds get what a new one gets (DEFAULT_PLACES in
-- src/gate/places/default-places.ts; a unit test keeps the two in step).
-- FORCE RLS applies here too: one compound at a time.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    INSERT INTO "places"
      ("id", "tenant_id", "key", "name_ar", "name_en", "position", "updated_at")
    SELECT gen_random_uuid(), t."id", s.key, s.name_ar, s.name_en, s.position, CURRENT_TIMESTAMP
      FROM (VALUES
        ('main_gate', 'البوابة الرئيسية', 'Main gate', 10),
        ('north_gate', 'البوابة الشمالية', 'North gate', 20),
        ('phase_a', 'المرحلة أ', 'Phase A', 30),
        ('phase_b', 'المرحلة ب', 'Phase B', 40),
        ('clubhouse', 'النادي', 'Clubhouse', 50),
        ('parking', 'الجراج', 'Parking', 60),
        ('other', 'مكان آخر', 'Other', 1000)
      ) AS s(key, name_ar, name_en, position);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
