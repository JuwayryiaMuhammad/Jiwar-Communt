-- ============================================================================
-- Tariffs and saving measures (ADR 0066). Consumption itself is computed on
-- read from the live readings; nothing here holds a total to go stale.
--
-- energy_tariffs   what a unit of a kind costs from a day on, never edited:
--                  a later day's tariff takes over.
-- energy_measures  something done to use less — on a meter, a building or
--                  the compound — from a day; its effect is read as the
--                  weeks before against the weeks after. Ended once.
-- ============================================================================

CREATE TABLE "energy_tariffs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "effective_on" DATE NOT NULL,
    "price_per_unit" DECIMAL(12,4) NOT NULL,
    "created_by_account_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "energy_tariffs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "energy_tariffs_tenant_id_id_key" ON "energy_tariffs"("tenant_id", "id");
CREATE UNIQUE INDEX "energy_tariffs_kind_day_key" ON "energy_tariffs"("tenant_id", "kind", "effective_on");
ALTER TABLE "energy_tariffs" ADD CONSTRAINT "energy_tariffs_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "energy_tariffs" ADD CONSTRAINT "energy_tariffs_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- METER_KINDS in src/maintenance/energy/meter-rules.ts.
ALTER TABLE "energy_tariffs" ADD CONSTRAINT "energy_tariffs_kind_known"
  CHECK ("kind" IN ('electricity', 'water', 'gas', 'fuel', 'run_hours'));
ALTER TABLE "energy_tariffs" ADD CONSTRAINT "energy_tariffs_price_range"
  CHECK ("price_per_unit" >= 0 AND "price_per_unit" < 100000000);

-- A tariff is never edited: an erasure may null who added it, nothing else.
CREATE FUNCTION "energy_tariffs_stand"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a tariff is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."kind" <> OLD."kind" OR NEW."effective_on" <> OLD."effective_on"
     OR NEW."price_per_unit" <> OLD."price_per_unit" OR NEW."created_at" <> OLD."created_at"
     OR NEW."created_by_account_id" IS NOT NULL THEN
    RAISE EXCEPTION 'a tariff is never edited' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "energy_tariffs_stand" BEFORE UPDATE OR DELETE ON "energy_tariffs"
  FOR EACH ROW EXECUTE FUNCTION "energy_tariffs_stand"();

CREATE TABLE "energy_measures" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "meter_id" UUID,
    "building" TEXT,
    "starts_on" DATE NOT NULL,
    "ended_on" DATE,
    "cost" DECIMAL(12,2),
    "created_by_account_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(3),
    "ended_by_account_id" UUID,
    CONSTRAINT "energy_measures_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "energy_measures_tenant_id_id_key" ON "energy_measures"("tenant_id", "id");
CREATE INDEX "energy_measures_list_idx" ON "energy_measures"("tenant_id", "starts_on", "id");
ALTER TABLE "energy_measures" ADD CONSTRAINT "energy_measures_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "energy_measures" ADD CONSTRAINT "energy_measures_meter_fkey"
  FOREIGN KEY ("tenant_id", "meter_id") REFERENCES "meters"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "energy_measures" ADD CONSTRAINT "energy_measures_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "energy_measures" ADD CONSTRAINT "energy_measures_ended_by_fkey"
  FOREIGN KEY ("tenant_id", "ended_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "energy_measures" ADD CONSTRAINT "energy_measures_kind_known"
  CHECK ("kind" IN ('electricity', 'water', 'gas', 'fuel', 'run_hours'));
ALTER TABLE "energy_measures" ADD CONSTRAINT "energy_measures_title_length"
  CHECK (char_length("title") BETWEEN 1 AND 120);
-- On one meter, one building, or the whole compound (neither).
ALTER TABLE "energy_measures" ADD CONSTRAINT "energy_measures_scope_one"
  CHECK ("meter_id" IS NULL OR "building" IS NULL);
ALTER TABLE "energy_measures" ADD CONSTRAINT "energy_measures_building_length"
  CHECK ("building" IS NULL OR char_length("building") BETWEEN 1 AND 80);
ALTER TABLE "energy_measures" ADD CONSTRAINT "energy_measures_cost_range"
  CHECK ("cost" IS NULL OR ("cost" >= 0 AND "cost" < 10000000000));
-- Ended once, on a day not before it started.
ALTER TABLE "energy_measures" ADD CONSTRAINT "energy_measures_ended_shape"
  CHECK (("ended_on" IS NULL) = ("ended_at" IS NULL)
     AND ("ended_on" IS NULL OR "ended_on" >= "starts_on"));

-- A measure keeps what it was; it is ended once. An erasure may null who
-- added or ended it, and nothing else.
CREATE FUNCTION "energy_measures_ended_once"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a measure is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."title" <> OLD."title" OR NEW."kind" <> OLD."kind"
     OR NEW."meter_id" IS DISTINCT FROM OLD."meter_id"
     OR NEW."building" IS DISTINCT FROM OLD."building"
     OR NEW."starts_on" <> OLD."starts_on"
     OR NEW."cost" IS DISTINCT FROM OLD."cost"
     OR NEW."created_at" <> OLD."created_at"
     OR (NEW."created_by_account_id" IS DISTINCT FROM OLD."created_by_account_id"
         AND NEW."created_by_account_id" IS NOT NULL)
     OR (OLD."ended_at" IS NOT NULL AND (
          NEW."ended_at" IS DISTINCT FROM OLD."ended_at"
       OR NEW."ended_on" IS DISTINCT FROM OLD."ended_on"
       OR (NEW."ended_by_account_id" IS DISTINCT FROM OLD."ended_by_account_id"
           AND NEW."ended_by_account_id" IS NOT NULL))) THEN
    RAISE EXCEPTION 'a measure keeps what it was, and is ended once'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "energy_measures_ended_once" BEFORE UPDATE OR DELETE ON "energy_measures"
  FOR EACH ROW EXECUTE FUNCTION "energy_measures_ended_once"();

-- ----------------------------------------------------------------------------
-- Grants: a tariff is only added (and an erasure nulls its author in place);
-- a measure is ended in place under its FOR UPDATE.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "energy_tariffs", "energy_measures" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "energy_tariffs", "energy_measures" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['energy_tariffs', 'energy_measures'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
