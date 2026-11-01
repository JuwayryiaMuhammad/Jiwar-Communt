-- ============================================================================
-- The unit register (ADR 0072): the compound's buildings.
--
-- A building was the free text a unit carries (`units.building`); audiences,
-- partners' service areas, governance and finance read that text and keep
-- building names of their own. So the text stays, and a building row gives
-- each name an id: `units.building_id` points at it, and a trigger keeps the
-- two in step whichever one a write sets.
--   - Set the id (the manager's PATCH /units/{id}): the text becomes the
--     building's name.
--   - Set the text (a unit created with a name, the registration's
--     activation): the id becomes that of the building of exactly that name,
--     a new one when the compound has none.
-- A building is never renamed (its name is stored elsewhere as a key) and is
-- deleted only when no unit names it (the foreign key). No personal data.
-- ============================================================================

CREATE TABLE "buildings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "buildings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "buildings_tenant_id_id_key" ON "buildings"("tenant_id", "id");
-- One building a name in a compound, exactly as written (the units' text is
-- matched exactly by the audiences).
CREATE UNIQUE INDEX "buildings_name_key" ON "buildings"("tenant_id", "name");
ALTER TABLE "buildings"
  ADD CONSTRAINT "buildings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "buildings" ADD CONSTRAINT "buildings_name_length"
  CHECK (char_length("name") BETWEEN 1 AND 64 AND "name" = btrim("name"));

-- A building's name never changes.
CREATE FUNCTION building_keeps_its_name() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."name" = OLD."name"
     AND NEW."created_at" = OLD."created_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'buildings: a building keeps its name'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER buildings_keep_name
  BEFORE UPDATE ON "buildings"
  FOR EACH ROW EXECUTE FUNCTION building_keeps_its_name();

-- UPDATE only for the row locks (FOR UPDATE / FOR KEY SHARE need it): the
-- trigger above refuses every change.
REVOKE ALL ON "buildings" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "buildings" TO jiwar_app;
ALTER TABLE "buildings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "buildings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "buildings"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "units" ADD COLUMN "building_id" UUID;
ALTER TABLE "units"
  ADD CONSTRAINT "units_tenant_id_building_fkey"
  FOREIGN KEY ("tenant_id", "building_id") REFERENCES "buildings"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX "units_building_idx" ON "units"("tenant_id", "building_id");

-- ----------------------------------------------------------------------------
-- Existing compounds: a building per distinct name their units carry, every
-- unit pointed at its own. A name over 64 characters (the registration never
-- bounded it) is cut to 64, the unit's text with it. FORCE RLS applies here
-- too: one compound at a time.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    INSERT INTO "buildings" ("id", "tenant_id", "name")
    SELECT gen_random_uuid(), t."id", n.name
      FROM (SELECT DISTINCT left(btrim("building"), 64) AS name
              FROM "units"
             WHERE "tenant_id" = t."id" AND btrim(coalesce("building", '')) <> '') n;
    UPDATE "units" u
       SET "building_id" = b."id", "building" = b."name"
      FROM "buildings" b
     WHERE u."tenant_id" = t."id"
       AND b."tenant_id" = t."id"
       AND b."name" = left(btrim(u."building"), 64);
    UPDATE "units"
       SET "building" = NULL
     WHERE "tenant_id" = t."id" AND "building" IS NOT NULL AND btrim("building") = '';
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

-- The text and the id come together.
ALTER TABLE "units" ADD CONSTRAINT "units_building_both"
  CHECK (("building" IS NULL) = ("building_id" IS NULL));

-- Keeps `building` and `building_id` in step (see the header). Runs as the
-- caller, so the building it may add is the caller's compound's (RLS).
CREATE FUNCTION unit_building_in_step() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  found_id uuid;
  found_name text;
BEGIN
  -- The id decides when a write set it.
  IF (TG_OP = 'INSERT' AND NEW."building_id" IS NOT NULL)
     OR (TG_OP = 'UPDATE' AND NEW."building_id" IS DISTINCT FROM OLD."building_id") THEN
    IF NEW."building_id" IS NULL THEN
      NEW."building" := NULL;
    ELSE
      SELECT b."name" INTO found_name
        FROM "buildings" b
       WHERE b."tenant_id" = NEW."tenant_id" AND b."id" = NEW."building_id";
      -- A missing building leaves the text as it is; the foreign key refuses.
      IF found_name IS NOT NULL THEN
        NEW."building" := found_name;
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."building" IS NOT DISTINCT FROM OLD."building" THEN
    RETURN NEW;
  END IF;
  -- The text was written: the building of that name.
  NEW."building" := NULLIF(btrim(NEW."building"), '');
  IF NEW."building" IS NULL THEN
    NEW."building_id" := NULL;
    RETURN NEW;
  END IF;
  -- FOR KEY SHARE, as the service holds a building it puts a unit in: a
  -- delete that got there first is waited for, and its row then skipped.
  SELECT b."id" INTO found_id
    FROM "buildings" b
   WHERE b."tenant_id" = NEW."tenant_id" AND b."name" = NEW."building"
     FOR KEY SHARE;
  IF found_id IS NULL THEN
    INSERT INTO "buildings" ("id", "tenant_id", "name")
    VALUES (gen_random_uuid(), NEW."tenant_id", NEW."building")
    ON CONFLICT DO NOTHING
    RETURNING "id" INTO found_id;
    -- Another transaction added it first: read it once it committed.
    IF found_id IS NULL THEN
      SELECT b."id" INTO found_id
        FROM "buildings" b
       WHERE b."tenant_id" = NEW."tenant_id" AND b."name" = NEW."building"
         FOR KEY SHARE;
    END IF;
  END IF;
  NEW."building_id" := found_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER units_building_in_step
  BEFORE INSERT OR UPDATE OF "building", "building_id" ON "units"
  FOR EACH ROW EXECUTE FUNCTION unit_building_in_step();
