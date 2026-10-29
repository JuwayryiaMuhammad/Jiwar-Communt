-- ============================================================================
-- Meter readings and spikes (ADR 0066).
--
-- meter_readings  what a meter showed on a day of the compound's calendar,
--                 never edited: entered by hand, imported, or recorded by a
--                 technician. One live reading per meter and day. A
--                 correction is a new row that supersedes the old one (the
--                 old row is marked superseded, once, with who and why); a
--                 withdrawal marks it superseded with nothing after it. A
--                 reset reading starts the register again from zero.
-- meter_alerts    a spike: the daily use up to a reading against the mean of
--                 the meter's last periods, once per meter and day, then
--                 acknowledged once.
--
-- The compound's spike rule lives on maintenance_settings: the factor over
-- the mean, and how many periods make the mean.
-- ============================================================================

ALTER TABLE "maintenance_settings" ADD COLUMN "anomaly_factor" DECIMAL(4,2) NOT NULL DEFAULT 2.00;
ALTER TABLE "maintenance_settings" ADD COLUMN "anomaly_periods" SMALLINT NOT NULL DEFAULT 6;
ALTER TABLE "maintenance_settings" ADD CONSTRAINT "maintenance_settings_anomaly_range"
  CHECK ("anomaly_factor" BETWEEN 1.2 AND 10 AND "anomaly_periods" BETWEEN 3 AND 24);

CREATE TABLE "meter_readings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "meter_id" UUID NOT NULL,
    "read_on" DATE NOT NULL,
    "value" DECIMAL(16,4) NOT NULL,
    "reset" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL,
    "import_id" UUID,
    "supersedes_id" UUID,
    "recorded_by_account_id" UUID,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "superseded_at" TIMESTAMPTZ(3),
    "superseded_by_account_id" UUID,
    "superseded_reason" TEXT,
    CONSTRAINT "meter_readings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "meter_readings_tenant_id_id_key" ON "meter_readings"("tenant_id", "id");
-- One live reading per meter and day: a duplicate is READING_EXISTS.
CREATE UNIQUE INDEX "meter_readings_live_day" ON "meter_readings"("tenant_id", "meter_id", "read_on")
  WHERE "superseded_at" IS NULL;
-- A reading is corrected once: READING_ALREADY_CORRECTED.
CREATE UNIQUE INDEX "meter_readings_supersedes_key" ON "meter_readings"("tenant_id", "supersedes_id")
  WHERE "supersedes_id" IS NOT NULL;
CREATE INDEX "meter_readings_meter_idx" ON "meter_readings"("tenant_id", "meter_id", "read_on", "id");
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_meter_fkey"
  FOREIGN KEY ("tenant_id", "meter_id") REFERENCES "meters"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_supersedes_fkey"
  FOREIGN KEY ("tenant_id", "supersedes_id") REFERENCES "meter_readings"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_recorded_by_fkey"
  FOREIGN KEY ("tenant_id", "recorded_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_superseded_by_fkey"
  FOREIGN KEY ("tenant_id", "superseded_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_value_range"
  CHECK ("value" >= 0 AND "value" < 1000000000000);
-- READING_SOURCES in src/maintenance/energy/reading-rules.ts; an import's
-- rows name it (the foreign key comes with the imports' table).
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_source_shape"
  CHECK ("source" IN ('manual', 'import', 'technician')
     AND ("source" = 'import') = ("import_id" IS NOT NULL));
-- Superseded once, with when and why (REASON_CODES.readingCorrect).
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_superseded_shape"
  CHECK (("superseded_at" IS NULL) = ("superseded_reason" IS NULL)
     AND ("superseded_reason" IS NULL
          OR "superseded_reason" IN ('misread', 'wrong_meter', 'wrong_day', 'other')));
-- A correction is of a reading of the same meter, never of itself.
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_not_self"
  CHECK ("supersedes_id" IS NULL OR "supersedes_id" <> "id");

-- A reading never changes: only its superseding is written, once. An
-- erasure may null who recorded or superseded it, and nothing else.
CREATE FUNCTION "meter_readings_stand"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a reading is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."meter_id" <> OLD."meter_id" OR NEW."read_on" <> OLD."read_on"
     OR NEW."value" <> OLD."value" OR NEW."reset" <> OLD."reset" OR NEW."source" <> OLD."source"
     OR NEW."import_id" IS DISTINCT FROM OLD."import_id"
     OR NEW."supersedes_id" IS DISTINCT FROM OLD."supersedes_id"
     OR NEW."recorded_at" <> OLD."recorded_at"
     OR (NEW."recorded_by_account_id" IS DISTINCT FROM OLD."recorded_by_account_id"
         AND NEW."recorded_by_account_id" IS NOT NULL)
     OR (OLD."superseded_at" IS NOT NULL AND (
          NEW."superseded_at" IS DISTINCT FROM OLD."superseded_at"
       OR NEW."superseded_reason" IS DISTINCT FROM OLD."superseded_reason"
       OR (NEW."superseded_by_account_id" IS DISTINCT FROM OLD."superseded_by_account_id"
           AND NEW."superseded_by_account_id" IS NOT NULL))) THEN
    RAISE EXCEPTION 'a reading never changes; it is superseded once'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "meter_readings_stand" BEFORE UPDATE OR DELETE ON "meter_readings"
  FOR EACH ROW EXECUTE FUNCTION "meter_readings_stand"();

CREATE TABLE "meter_alerts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "meter_id" UUID NOT NULL,
    "reading_id" UUID NOT NULL,
    "read_on" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "daily_rate" DECIMAL(16,4) NOT NULL,
    "baseline_rate" DECIMAL(16,4) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_at" TIMESTAMPTZ(3),
    "acknowledged_by_account_id" UUID,
    CONSTRAINT "meter_alerts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "meter_alerts_tenant_id_id_key" ON "meter_alerts"("tenant_id", "id");
-- Once per meter and day, whatever races (ON CONFLICT DO NOTHING).
CREATE UNIQUE INDEX "meter_alerts_meter_day_key" ON "meter_alerts"("tenant_id", "meter_id", "read_on");
CREATE INDEX "meter_alerts_list_idx" ON "meter_alerts"("tenant_id", "created_at", "id");
ALTER TABLE "meter_alerts" ADD CONSTRAINT "meter_alerts_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "meter_alerts" ADD CONSTRAINT "meter_alerts_meter_fkey"
  FOREIGN KEY ("tenant_id", "meter_id") REFERENCES "meters"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "meter_alerts" ADD CONSTRAINT "meter_alerts_reading_fkey"
  FOREIGN KEY ("tenant_id", "reading_id") REFERENCES "meter_readings"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "meter_alerts" ADD CONSTRAINT "meter_alerts_acknowledged_by_fkey"
  FOREIGN KEY ("tenant_id", "acknowledged_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- ALERT_KINDS in src/maintenance/energy/reading-rules.ts: spikes only.
ALTER TABLE "meter_alerts" ADD CONSTRAINT "meter_alerts_kind_known"
  CHECK ("kind" IN ('spike'));
ALTER TABLE "meter_alerts" ADD CONSTRAINT "meter_alerts_rates_range"
  CHECK ("daily_rate" >= 0 AND "baseline_rate" >= 0);

-- An alert says what it said; it is acknowledged once.
CREATE FUNCTION "meter_alerts_acknowledged_once"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an alert is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."meter_id" <> OLD."meter_id" OR NEW."reading_id" <> OLD."reading_id"
     OR NEW."read_on" <> OLD."read_on" OR NEW."kind" <> OLD."kind"
     OR NEW."daily_rate" <> OLD."daily_rate" OR NEW."baseline_rate" <> OLD."baseline_rate"
     OR NEW."created_at" <> OLD."created_at"
     OR (OLD."acknowledged_at" IS NOT NULL AND (
          NEW."acknowledged_at" IS DISTINCT FROM OLD."acknowledged_at"
       OR (NEW."acknowledged_by_account_id" IS DISTINCT FROM OLD."acknowledged_by_account_id"
           AND NEW."acknowledged_by_account_id" IS NOT NULL))) THEN
    RAISE EXCEPTION 'an alert is acknowledged once, and never changed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "meter_alerts_acknowledged_once" BEFORE UPDATE OR DELETE ON "meter_alerts"
  FOR EACH ROW EXECUTE FUNCTION "meter_alerts_acknowledged_once"();

-- ----------------------------------------------------------------------------
-- Grants: a reading is superseded in place, an alert acknowledged in place;
-- both are written under their meter's FOR UPDATE, an alert under its own.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "meter_readings", "meter_alerts" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "meter_readings", "meter_alerts" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['meter_readings', 'meter_alerts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
