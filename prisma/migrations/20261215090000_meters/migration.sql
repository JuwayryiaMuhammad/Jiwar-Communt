-- ============================================================================
-- Meters (ADR 0066): what the compound measures — electricity, water, gas,
-- fuel and a generator's running hours — in a unit or a common area, and
-- optionally on an asset (it then stands where the asset stands). A meter
-- keeps its kind, mode, multiplier and place for life: a replaced meter is
-- a new one, or a reset reading. Retired once, with a reason; never deleted.
-- ============================================================================

CREATE TABLE "meters" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'cumulative',
    "multiplier" DECIMAL(10,4) NOT NULL DEFAULT 1,
    "unit_id" UUID,
    "common_area_id" UUID,
    "asset_id" UUID,
    "serial" TEXT,
    "installed_on" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "retired_at" TIMESTAMPTZ(3),
    "retired_by_account_id" UUID,
    "retire_reason" TEXT,
    "created_by_account_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "meters_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "meters_tenant_id_id_key" ON "meters"("tenant_id", "id");
CREATE UNIQUE INDEX "meters_tenant_id_code_key" ON "meters"("tenant_id", "code");
CREATE INDEX "meters_list_idx" ON "meters"("tenant_id", "kind", "code");
CREATE INDEX "meters_unit_idx" ON "meters"("tenant_id", "unit_id") WHERE "unit_id" IS NOT NULL;
CREATE INDEX "meters_area_idx" ON "meters"("tenant_id", "common_area_id") WHERE "common_area_id" IS NOT NULL;
ALTER TABLE "meters" ADD CONSTRAINT "meters_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "meters" ADD CONSTRAINT "meters_unit_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "meters" ADD CONSTRAINT "meters_common_area_fkey"
  FOREIGN KEY ("tenant_id", "common_area_id") REFERENCES "common_areas"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "meters" ADD CONSTRAINT "meters_asset_fkey"
  FOREIGN KEY ("tenant_id", "asset_id") REFERENCES "assets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "meters" ADD CONSTRAINT "meters_retired_by_fkey"
  FOREIGN KEY ("tenant_id", "retired_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "meters" ADD CONSTRAINT "meters_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "meters" ADD CONSTRAINT "meters_code_shape"
  CHECK ("code" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$');
-- METER_KINDS and METER_MODES in src/maintenance/energy/meters/meter-rules.ts.
ALTER TABLE "meters" ADD CONSTRAINT "meters_kind_known"
  CHECK ("kind" IN ('electricity', 'water', 'gas', 'fuel', 'run_hours'));
ALTER TABLE "meters" ADD CONSTRAINT "meters_mode_known"
  CHECK ("mode" IN ('cumulative', 'interval'));
ALTER TABLE "meters" ADD CONSTRAINT "meters_multiplier_range"
  CHECK ("multiplier" > 0 AND "multiplier" < 100000);
-- In a unit or in a common area, never both, never neither.
ALTER TABLE "meters" ADD CONSTRAINT "meters_location_one"
  CHECK (("unit_id" IS NULL) <> ("common_area_id" IS NULL));
ALTER TABLE "meters" ADD CONSTRAINT "meters_serial_length"
  CHECK ("serial" IS NULL OR char_length("serial") BETWEEN 1 AND 60);
-- Retired once, with when and why (REASON_CODES.meterRetire).
ALTER TABLE "meters" ADD CONSTRAINT "meters_retired_shape"
  CHECK (("retired_at" IS NULL) = ("retire_reason" IS NULL)
     AND "active" = ("retired_at" IS NULL)
     AND ("retire_reason" IS NULL
          OR "retire_reason" IN ('replaced', 'removed', 'faulty', 'other')));

-- A meter keeps its code, kind, mode, multiplier and place for life, so a
-- reading always means what it meant; it is retired once and then never
-- changes. An erasure may null who retired or added it, and nothing else.
CREATE FUNCTION "meters_keep_their_measure"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a meter is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."code" <> OLD."code" OR NEW."kind" <> OLD."kind" OR NEW."mode" <> OLD."mode"
     OR NEW."multiplier" <> OLD."multiplier"
     OR NEW."unit_id" IS DISTINCT FROM OLD."unit_id"
     OR NEW."common_area_id" IS DISTINCT FROM OLD."common_area_id"
     OR NEW."created_at" <> OLD."created_at"
     OR (OLD."retired_at" IS NOT NULL AND (
          NEW."retired_at" IS DISTINCT FROM OLD."retired_at"
       OR NEW."retire_reason" IS DISTINCT FROM OLD."retire_reason"
       OR NEW."active" <> OLD."active"
       OR NEW."asset_id" IS DISTINCT FROM OLD."asset_id"
       OR NEW."serial" IS DISTINCT FROM OLD."serial"
       OR NEW."installed_on" IS DISTINCT FROM OLD."installed_on"
       OR (NEW."retired_by_account_id" IS DISTINCT FROM OLD."retired_by_account_id"
           AND NEW."retired_by_account_id" IS NOT NULL))) THEN
    RAISE EXCEPTION 'a meter keeps its measure, and a retired one never changes'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "meters_keep_their_measure" BEFORE UPDATE OR DELETE ON "meters"
  FOR EACH ROW EXECUTE FUNCTION "meters_keep_their_measure"();

-- ----------------------------------------------------------------------------
-- Grants: a meter changes in place under FOR UPDATE, which every reading,
-- correction and import takes before it reads the meter's readings.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "meters" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "meters" TO jiwar_app;

ALTER TABLE "meters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meters" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "meters"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
