-- ============================================================================
-- Work orders the compound opens itself (ADR 0064): a ticket's origin.
--
--   resident    opened by a resident, or for one by dispatch: every ticket
--               until now (the default fills them; no row is written);
--   plan        generated from a maintenance plan, for an asset;
--   inspection  a failed inspection item's follow-up, for an asset or an
--               area;
--   field       a fault a technician found on an asset.
--
-- A staff-origin ticket keeps every column a resident ticket has, so an
-- app rolled back past this phase still reads it: its reporter and creator
-- are the staff member who answers for it, and in a common area its
-- `common_area` label is the area's name, written once beside the area's
-- id. It names its asset (or, for an inspection's finding without one, its
-- area). Origin, asset and area never change (a trigger).
--
-- Who sees one on the resident side is the app's rule (ticket-visibility):
-- a field ticket on an asset in a unit, for that unit's household (a
-- technician has to get in); no other staff-origin ticket.
-- ============================================================================

ALTER TABLE "tickets" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'resident';
ALTER TABLE "tickets" ADD COLUMN "asset_id" UUID;
ALTER TABLE "tickets" ADD COLUMN "common_area_id" UUID;

ALTER TABLE "tickets" ADD CONSTRAINT "tickets_tenant_id_asset_id_fkey"
  FOREIGN KEY ("tenant_id", "asset_id") REFERENCES "assets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_tenant_id_common_area_id_fkey"
  FOREIGN KEY ("tenant_id", "common_area_id") REFERENCES "common_areas"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_origin_known"
  CHECK ("origin" IN ('resident', 'plan', 'inspection', 'field'));
-- A resident's ticket names no asset or area; the compound's are repairs
-- that name one (a plan's and a field fault's, an asset).
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_origin_shape"
  CHECK (("origin" = 'resident' AND "asset_id" IS NULL AND "common_area_id" IS NULL)
      OR ("origin" IN ('plan', 'field') AND "kind" = 'repair' AND "asset_id" IS NOT NULL)
      OR ("origin" = 'inspection' AND "kind" = 'repair'
          AND ("asset_id" IS NOT NULL OR "common_area_id" IS NOT NULL)));
-- An area's id rides with its label (the unit-or-label CHECK still holds).
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_common_area_id_has_label"
  CHECK ("common_area_id" IS NULL OR ("common_area" IS NOT NULL AND "unit_id" IS NULL));

CREATE INDEX "tickets_asset_idx" ON "tickets"("tenant_id", "asset_id", "created_at" DESC)
  WHERE "asset_id" IS NOT NULL;
CREATE INDEX "tickets_origin_idx" ON "tickets"("tenant_id", "origin", "created_at" DESC, "id" DESC);

CREATE FUNCTION "tickets_origin_is_fixed"() RETURNS trigger AS $$
BEGIN
  IF NEW."origin" <> OLD."origin"
     OR NEW."asset_id" IS DISTINCT FROM OLD."asset_id"
     OR NEW."common_area_id" IS DISTINCT FROM OLD."common_area_id" THEN
    RAISE EXCEPTION 'a ticket keeps its origin, asset and area' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "tickets_origin_is_fixed" BEFORE UPDATE ON "tickets"
  FOR EACH ROW EXECUTE FUNCTION "tickets_origin_is_fixed"();
