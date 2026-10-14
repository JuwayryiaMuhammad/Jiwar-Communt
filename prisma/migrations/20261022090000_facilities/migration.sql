-- ============================================================================
-- Phase R5 — facilities (ADR 0044). The compound's facilities, the rules a
-- bookable one is booked by, its weekly opening hours and its peak times.
-- No personal data here.
-- ============================================================================

CREATE TYPE "facility_mode" AS ENUM ('bookable', 'walk_in');
CREATE TYPE "facility_capacity_unit" AS ENUM ('bookings', 'people');

-- ----------------------------------------------------------------------------
-- Facilities. Never deleted (bookings point at them); retired with
-- `active`. The rules are set exactly when the facility is bookable; a
-- walk-in facility (the pool, the gym) is its names, its description and
-- its hours. Its mode never changes.
-- ----------------------------------------------------------------------------
CREATE TABLE "facilities" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "mode" "facility_mode" NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "description_en" TEXT,
    "description_ar" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "slot_minutes" INTEGER,
    "capacity" INTEGER,
    "capacity_unit" "facility_capacity_unit",
    "max_days_ahead" INTEGER,
    "min_minutes_before" INTEGER,
    "cancel_cutoff_minutes" INTEGER,
    "max_guests" INTEGER,
    "requires_approval" BOOLEAN NOT NULL DEFAULT false,
    "requires_membership" BOOLEAN NOT NULL DEFAULT false,
    "weekly_quota" INTEGER,
    "peak_quota" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "facilities_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "facilities_tenant_id_id_key" ON "facilities"("tenant_id", "id");
CREATE INDEX "facilities_position_idx" ON "facilities"("tenant_id", "position", "id");
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_names_length"
  CHECK (char_length("name_en") BETWEEN 1 AND 80 AND char_length("name_ar") BETWEEN 1 AND 80);
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_descriptions_length"
  CHECK (("description_en" IS NULL OR char_length("description_en") BETWEEN 1 AND 1000)
     AND ("description_ar" IS NULL OR char_length("description_ar") BETWEEN 1 AND 1000));
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_position_range"
  CHECK ("position" BETWEEN 0 AND 1000);
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_rules_shape"
  CHECK (("mode" = 'bookable'
          AND "slot_minutes" IS NOT NULL AND "capacity" IS NOT NULL
          AND "capacity_unit" IS NOT NULL AND "max_days_ahead" IS NOT NULL
          AND "min_minutes_before" IS NOT NULL AND "cancel_cutoff_minutes" IS NOT NULL
          AND "max_guests" IS NOT NULL AND "weekly_quota" IS NOT NULL
          AND "peak_quota" IS NOT NULL)
      OR ("mode" = 'walk_in'
          AND "slot_minutes" IS NULL AND "capacity" IS NULL
          AND "capacity_unit" IS NULL AND "max_days_ahead" IS NULL
          AND "min_minutes_before" IS NULL AND "cancel_cutoff_minutes" IS NULL
          AND "max_guests" IS NULL AND "weekly_quota" IS NULL
          AND "peak_quota" IS NULL
          AND NOT "requires_approval" AND NOT "requires_membership"));
-- The ranges of the rules (RULE_RANGES in src/facilities/setup/facility-rules.ts;
-- a unit test keeps the two in step). Each is NULL on a walk-in facility.
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_rules_ranges"
  CHECK (("slot_minutes" IS NULL OR "slot_minutes" BETWEEN 15 AND 480)
     AND ("capacity" IS NULL OR "capacity" BETWEEN 1 AND 500)
     AND ("max_days_ahead" IS NULL OR "max_days_ahead" BETWEEN 1 AND 90)
     AND ("min_minutes_before" IS NULL OR "min_minutes_before" BETWEEN 0 AND 10080)
     AND ("cancel_cutoff_minutes" IS NULL OR "cancel_cutoff_minutes" BETWEEN 0 AND 10080)
     AND ("max_guests" IS NULL OR "max_guests" BETWEEN 0 AND 50)
     AND ("weekly_quota" IS NULL OR "weekly_quota" BETWEEN 1 AND 20)
     AND ("peak_quota" IS NULL OR "peak_quota" BETWEEN 1 AND 20));
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_peak_quota_within_weekly"
  CHECK ("peak_quota" IS NULL OR "weekly_quota" IS NULL OR "peak_quota" <= "weekly_quota");

-- A facility is never deleted and never changes what it is.
CREATE FUNCTION facility_keeps_its_mode() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."mode" = OLD."mode"
     AND NEW."created_at" = OLD."created_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'facilities: a facility keeps its mode and is never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER facilities_keep_mode
  BEFORE UPDATE OR DELETE ON "facilities"
  FOR EACH ROW EXECUTE FUNCTION facility_keeps_its_mode();
CREATE TRIGGER facilities_keep_mode_truncate
  BEFORE TRUNCATE ON "facilities"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Weekly windows: the opening hours, and the peak times inside them.
-- Weekday 0 is Sunday; minutes after local midnight in the compound's
-- time zone; a window ends on its own day. Replaced as a whole under the
-- facility's row lock.
-- ----------------------------------------------------------------------------
CREATE TABLE "facility_hours" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "facility_id" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,
    CONSTRAINT "facility_hours_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "facility_hours_window_key"
  ON "facility_hours"("tenant_id", "facility_id", "weekday", "start_minute");
ALTER TABLE "facility_hours" ADD CONSTRAINT "facility_hours_tenant_id_facility_id_fkey"
  FOREIGN KEY ("tenant_id", "facility_id") REFERENCES "facilities"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "facility_hours" ADD CONSTRAINT "facility_hours_window"
  CHECK ("weekday" BETWEEN 0 AND 6
     AND "start_minute" BETWEEN 0 AND 1439
     AND "end_minute" BETWEEN 1 AND 1440
     AND "start_minute" < "end_minute");

CREATE TABLE "facility_peak_windows" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "facility_id" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,
    CONSTRAINT "facility_peak_windows_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "facility_peak_windows_window_key"
  ON "facility_peak_windows"("tenant_id", "facility_id", "weekday", "start_minute");
ALTER TABLE "facility_peak_windows" ADD CONSTRAINT "facility_peak_windows_tenant_id_facility_id_fkey"
  FOREIGN KEY ("tenant_id", "facility_id") REFERENCES "facilities"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "facility_peak_windows" ADD CONSTRAINT "facility_peak_windows_window"
  CHECK ("weekday" BETWEEN 0 AND 6
     AND "start_minute" BETWEEN 0 AND 1439
     AND "end_minute" BETWEEN 1 AND 1440
     AND "start_minute" < "end_minute");

-- ----------------------------------------------------------------------------
-- Privileges and RLS. Facilities are never deleted; window sets are
-- replaced, so their rows are.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "facilities", "facility_hours", "facility_peak_windows" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "facilities" TO jiwar_app;
GRANT SELECT, INSERT, DELETE ON "facility_hours", "facility_peak_windows" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['facilities', 'facility_hours', 'facility_peak_windows'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
