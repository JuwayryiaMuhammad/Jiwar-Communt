-- ============================================================================
-- Phase R5 — no-shows and suspensions (ADR 0044). The compound's no-show
-- settings, and a unit's suspension from booking after too many no-shows.
-- No free text.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Settings: one row per compound, created with it and backfilled below.
-- ----------------------------------------------------------------------------
CREATE TABLE "facility_settings" (
    "tenant_id" UUID NOT NULL,
    "no_show_threshold" INTEGER NOT NULL DEFAULT 3,
    "no_show_window_days" INTEGER NOT NULL DEFAULT 30,
    "suspension_days" INTEGER NOT NULL DEFAULT 14,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "facility_settings_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "facility_settings" ADD CONSTRAINT "facility_settings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "facility_settings" ADD CONSTRAINT "facility_settings_ranges"
  CHECK ("no_show_threshold" BETWEEN 1 AND 10
     AND "no_show_window_days" BETWEEN 7 AND 90
     AND "suspension_days" BETWEEN 1 AND 90);

-- ----------------------------------------------------------------------------
-- A unit's suspension from booking: started by the no-show that reached
-- the threshold (once per booking), over at `ends_at`, or lifted by the
-- staff with a reason code. Only the lift changes it, once (trigger).
-- ----------------------------------------------------------------------------
CREATE TABLE "booking_suspensions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "trigger_booking_id" UUID NOT NULL,
    "no_show_count" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lifted_at" TIMESTAMPTZ(3),
    "lifted_by_account_id" UUID,
    "lift_reason_code" TEXT,
    CONSTRAINT "booking_suspensions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "booking_suspensions_tenant_id_id_key" ON "booking_suspensions"("tenant_id", "id");
CREATE UNIQUE INDEX "booking_suspensions_trigger_booking_id_key"
  ON "booking_suspensions"("tenant_id", "trigger_booking_id");
CREATE INDEX "booking_suspensions_unit_idx"
  ON "booking_suspensions"("tenant_id", "unit_id", "starts_at", "id");
CREATE INDEX "booking_suspensions_starts_idx"
  ON "booking_suspensions"("tenant_id", "starts_at", "id");
ALTER TABLE "booking_suspensions"
  ADD CONSTRAINT "booking_suspensions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "booking_suspensions_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "booking_suspensions_tenant_id_trigger_booking_id_fkey"
  FOREIGN KEY ("tenant_id", "trigger_booking_id") REFERENCES "bookings"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "booking_suspensions_tenant_id_lifted_by_fkey"
  FOREIGN KEY ("tenant_id", "lifted_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "booking_suspensions" ADD CONSTRAINT "booking_suspensions_window"
  CHECK ("ends_at" > "starts_at" AND "ends_at" <= "starts_at" + interval '90 days');
ALTER TABLE "booking_suspensions" ADD CONSTRAINT "booking_suspensions_count"
  CHECK ("no_show_count" BETWEEN 1 AND 1000);
ALTER TABLE "booking_suspensions" ADD CONSTRAINT "booking_suspensions_lifted_shape"
  CHECK (("lifted_at" IS NULL) = ("lifted_by_account_id" IS NULL)
     AND ("lifted_at" IS NULL) = ("lift_reason_code" IS NULL));
-- REASON_CODES.bookingSuspensionLift; a unit test keeps the two in step.
ALTER TABLE "booking_suspensions" ADD CONSTRAINT "booking_suspensions_lift_reason"
  CHECK ("lift_reason_code" IS NULL
      OR "lift_reason_code" IN ('staff_error', 'exception_granted', 'other'));

CREATE FUNCTION booking_suspension_keeps_its_window() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."unit_id" = OLD."unit_id"
     AND NEW."starts_at" = OLD."starts_at"
     AND NEW."ends_at" = OLD."ends_at"
     AND NEW."trigger_booking_id" = OLD."trigger_booking_id"
     AND NEW."no_show_count" = OLD."no_show_count"
     AND NEW."created_at" = OLD."created_at"
     AND (
       (NEW."lifted_at" IS NOT DISTINCT FROM OLD."lifted_at"
        AND NEW."lifted_by_account_id" IS NOT DISTINCT FROM OLD."lifted_by_account_id"
        AND NEW."lift_reason_code" IS NOT DISTINCT FROM OLD."lift_reason_code")
       OR OLD."lifted_at" IS NULL
     ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'booking_suspensions: a suspension keeps its window and is lifted once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER booking_suspensions_keep_window
  BEFORE UPDATE OR DELETE ON "booking_suspensions"
  FOR EACH ROW EXECUTE FUNCTION booking_suspension_keeps_its_window();
CREATE TRIGGER booking_suspensions_keep_window_truncate
  BEFORE TRUNCATE ON "booking_suspensions"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Privileges and RLS. Nothing here is deleted.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "facility_settings", "booking_suspensions" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "facility_settings", "booking_suspensions" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['facility_settings', 'booking_suspensions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Existing compounds get what a new one gets (src/facilities/provisioning.ts):
-- the settings row. FORCE RLS applies here too: one compound at a time.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    INSERT INTO "facility_settings" ("tenant_id", "updated_at")
      VALUES (t."id", CURRENT_TIMESTAMP);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
