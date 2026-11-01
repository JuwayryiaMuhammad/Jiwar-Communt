-- ============================================================================
-- The management's own work orders (ADR 0076): a fifth origin, `staff`, for a
-- job the dispatch opens itself on an asset or a common area (a fault seen on
-- a walk, a device, an energy spike), dispatched and measured like any repair.
--
-- A staff work order may say it answers a meter's spike (ADR 0066): at most
-- one work order per alert, and only a staff one. Opening it acknowledges the
-- alert if nobody had. Like its origin, asset and area, the link never
-- changes (the trigger widened below).
-- ============================================================================

ALTER TABLE "tickets" DROP CONSTRAINT "tickets_origin_known";
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_origin_known"
  CHECK ("origin" IN ('resident', 'plan', 'inspection', 'field', 'staff'));

-- A resident's ticket names no asset or area; the compound's are repairs
-- that name one (a plan's and a field fault's, an asset; an inspection's and
-- the management's own, an asset or an area).
ALTER TABLE "tickets" DROP CONSTRAINT "tickets_origin_shape";
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_origin_shape"
  CHECK (("origin" = 'resident' AND "asset_id" IS NULL AND "common_area_id" IS NULL)
      OR ("origin" IN ('plan', 'field') AND "kind" = 'repair' AND "asset_id" IS NOT NULL)
      OR ("origin" IN ('inspection', 'staff') AND "kind" = 'repair'
          AND ("asset_id" IS NOT NULL OR "common_area_id" IS NOT NULL)));

ALTER TABLE "tickets" ADD COLUMN "meter_alert_id" UUID;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_tenant_id_meter_alert_id_fkey"
  FOREIGN KEY ("tenant_id", "meter_alert_id") REFERENCES "meter_alerts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_meter_alert_staff_only"
  CHECK ("meter_alert_id" IS NULL OR "origin" = 'staff');
CREATE UNIQUE INDEX "tickets_one_per_meter_alert"
  ON "tickets"("tenant_id", "meter_alert_id") WHERE "meter_alert_id" IS NOT NULL;

CREATE OR REPLACE FUNCTION "tickets_origin_is_fixed"() RETURNS trigger AS $$
BEGIN
  IF NEW."origin" <> OLD."origin"
     OR NEW."asset_id" IS DISTINCT FROM OLD."asset_id"
     OR NEW."common_area_id" IS DISTINCT FROM OLD."common_area_id"
     OR NEW."meter_alert_id" IS DISTINCT FROM OLD."meter_alert_id" THEN
    RAISE EXCEPTION 'a ticket keeps its origin, asset, area and alert' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
