-- ============================================================================
-- The site map and the floor plans (ADR 0084). Images through the files
-- service (ADR 0029), attached to their record; places on them in fractions
-- of the image's width and height, from its top left corner, so "within the
-- image" is a CHECK and a sharper scan of the same drawing keeps them.
--
-- - site_maps: the compound's one map image; site_map_points: one point
--   each for a building (ADR 0072), a gate or a facility, at most one per
--   place.
-- - floor_plans: one image per building and floor; floor_plan_units: a
--   unit's hotspot, a box inside the image, on the plan of its own building
--   and floor (checked by the service; a unit moved since is shown so to
--   the staff), one plan per unit. A resident reads their own unit's box
--   only, never another unit's.
--
-- No personal data here. The writers lock the map's row or the plan's row
-- FOR UPDATE; a hotspot list or a point list is replaced whole.
-- ============================================================================

CREATE TABLE "site_maps" (
    "tenant_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "site_maps_pkey" PRIMARY KEY ("tenant_id")
);
CREATE UNIQUE INDEX "site_maps_file_key" ON "site_maps"("file_id");
ALTER TABLE "site_maps"
  ADD CONSTRAINT "site_maps_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "site_maps_tenant_id_file_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "site_map_points" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "building_id" UUID,
    "gate_id" UUID,
    "facility_id" UUID,
    "x" DECIMAL(6,5) NOT NULL,
    "y" DECIMAL(6,5) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "site_map_points_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "site_map_points_tenant_id_id_key" ON "site_map_points"("tenant_id", "id");
CREATE UNIQUE INDEX "site_map_points_one_a_building"
  ON "site_map_points"("tenant_id", "building_id") WHERE "building_id" IS NOT NULL;
CREATE UNIQUE INDEX "site_map_points_one_a_gate"
  ON "site_map_points"("tenant_id", "gate_id") WHERE "gate_id" IS NOT NULL;
CREATE UNIQUE INDEX "site_map_points_one_a_facility"
  ON "site_map_points"("tenant_id", "facility_id") WHERE "facility_id" IS NOT NULL;
ALTER TABLE "site_map_points"
  ADD CONSTRAINT "site_map_points_tenant_id_map_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "site_maps"("tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "site_map_points_tenant_id_building_fkey"
  FOREIGN KEY ("tenant_id", "building_id") REFERENCES "buildings"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "site_map_points_tenant_id_gate_fkey"
  FOREIGN KEY ("tenant_id", "gate_id") REFERENCES "gates"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "site_map_points_tenant_id_facility_fkey"
  FOREIGN KEY ("tenant_id", "facility_id") REFERENCES "facilities"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- Exactly the place its kind names.
ALTER TABLE "site_map_points" ADD CONSTRAINT "site_map_points_place"
  CHECK ("kind" IN ('building', 'gate', 'facility')
     AND (("kind" = 'building') = ("building_id" IS NOT NULL))
     AND (("kind" = 'gate') = ("gate_id" IS NOT NULL))
     AND (("kind" = 'facility') = ("facility_id" IS NOT NULL)));
ALTER TABLE "site_map_points" ADD CONSTRAINT "site_map_points_inside"
  CHECK ("x" BETWEEN 0 AND 1 AND "y" BETWEEN 0 AND 1);

CREATE TABLE "floor_plans" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "building_id" UUID NOT NULL,
    "floor" INTEGER NOT NULL,
    "file_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "floor_plans_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "floor_plans_tenant_id_id_key" ON "floor_plans"("tenant_id", "id");
CREATE UNIQUE INDEX "floor_plans_one_a_floor" ON "floor_plans"("tenant_id", "building_id", "floor");
CREATE UNIQUE INDEX "floor_plans_file_key" ON "floor_plans"("file_id");
ALTER TABLE "floor_plans"
  ADD CONSTRAINT "floor_plans_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "floor_plans_tenant_id_building_fkey"
  FOREIGN KEY ("tenant_id", "building_id") REFERENCES "buildings"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "floor_plans_tenant_id_file_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- A unit's floor's range (CreateUnitDto).
ALTER TABLE "floor_plans" ADD CONSTRAINT "floor_plans_floor_range"
  CHECK ("floor" BETWEEN -5 AND 200);

CREATE TABLE "floor_plan_units" (
    "tenant_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "x" DECIMAL(6,5) NOT NULL,
    "y" DECIMAL(6,5) NOT NULL,
    "width" DECIMAL(6,5) NOT NULL,
    "height" DECIMAL(6,5) NOT NULL,
    CONSTRAINT "floor_plan_units_pkey" PRIMARY KEY ("plan_id", "unit_id")
);
CREATE UNIQUE INDEX "floor_plan_units_one_plan" ON "floor_plan_units"("tenant_id", "unit_id");
ALTER TABLE "floor_plan_units"
  ADD CONSTRAINT "floor_plan_units_tenant_id_plan_fkey"
  FOREIGN KEY ("tenant_id", "plan_id") REFERENCES "floor_plans"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "floor_plan_units_tenant_id_unit_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- A box inside the image.
ALTER TABLE "floor_plan_units" ADD CONSTRAINT "floor_plan_units_inside"
  CHECK ("x" >= 0 AND "y" >= 0 AND "width" > 0 AND "height" > 0
     AND "x" + "width" <= 1 AND "y" + "height" <= 1);

REVOKE ALL ON "site_maps", "site_map_points", "floor_plans", "floor_plan_units" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "site_maps" TO jiwar_app;
GRANT SELECT, INSERT, DELETE ON "site_map_points" TO jiwar_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "floor_plans" TO jiwar_app;
GRANT SELECT, INSERT, DELETE ON "floor_plan_units" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['site_maps', 'site_map_points', 'floor_plans', 'floor_plan_units'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
