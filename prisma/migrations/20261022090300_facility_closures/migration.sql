-- ============================================================================
-- Phase R5 — closures (ADR 0044). A facility closed for a time, with a
-- reason code; creating one cancels the future bookings it overlaps, each
-- pointing at it. No free text.
-- ============================================================================

CREATE TABLE "facility_closures" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "facility_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "reason_code" TEXT NOT NULL,
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lifted_at" TIMESTAMPTZ(3),
    "lifted_by_account_id" UUID,
    "lift_reason_code" TEXT,
    CONSTRAINT "facility_closures_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "facility_closures_tenant_id_id_key" ON "facility_closures"("tenant_id", "id");
CREATE INDEX "facility_closures_facility_idx"
  ON "facility_closures"("tenant_id", "facility_id", "starts_at", "id");
ALTER TABLE "facility_closures"
  ADD CONSTRAINT "facility_closures_tenant_id_facility_id_fkey"
  FOREIGN KEY ("tenant_id", "facility_id") REFERENCES "facilities"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "facility_closures_tenant_id_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "facility_closures_tenant_id_lifted_by_fkey"
  FOREIGN KEY ("tenant_id", "lifted_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- At most a year and a day.
ALTER TABLE "facility_closures" ADD CONSTRAINT "facility_closures_window"
  CHECK ("ends_at" > "starts_at" AND "ends_at" <= "starts_at" + interval '366 days');
-- The reason lists (REASON_CODES in src/core/common/reasons.ts; a unit test
-- keeps the two in step).
ALTER TABLE "facility_closures" ADD CONSTRAINT "facility_closures_reason"
  CHECK ("reason_code" IN ('maintenance', 'cleaning', 'private_event', 'weather', 'other'));
ALTER TABLE "facility_closures" ADD CONSTRAINT "facility_closures_lifted_shape"
  CHECK (("lifted_at" IS NULL) = ("lifted_by_account_id" IS NULL)
     AND ("lifted_at" IS NULL) = ("lift_reason_code" IS NULL));
ALTER TABLE "facility_closures" ADD CONSTRAINT "facility_closures_lift_reason"
  CHECK ("lift_reason_code" IS NULL
      OR "lift_reason_code" IN ('reopened_early', 'created_in_error', 'other'));

-- A closure keeps its facility, window, reason and author; it is lifted
-- once, and never deleted.
CREATE FUNCTION facility_closure_keeps_its_window() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."facility_id" = OLD."facility_id"
     AND NEW."starts_at" = OLD."starts_at"
     AND NEW."ends_at" = OLD."ends_at"
     AND NEW."reason_code" = OLD."reason_code"
     AND NEW."created_by_account_id" = OLD."created_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND (
       (NEW."lifted_at" IS NOT DISTINCT FROM OLD."lifted_at"
        AND NEW."lifted_by_account_id" IS NOT DISTINCT FROM OLD."lifted_by_account_id"
        AND NEW."lift_reason_code" IS NOT DISTINCT FROM OLD."lift_reason_code")
       OR OLD."lifted_at" IS NULL
     ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'facility_closures: a closure keeps its window and is lifted once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER facility_closures_keep_window
  BEFORE UPDATE OR DELETE ON "facility_closures"
  FOR EACH ROW EXECUTE FUNCTION facility_closure_keeps_its_window();
CREATE TRIGGER facility_closures_keep_window_truncate
  BEFORE TRUNCATE ON "facility_closures"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- A booking a closure cancelled points at it.
-- ----------------------------------------------------------------------------
ALTER TABLE "bookings" ADD COLUMN "closure_id" UUID;
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_tenant_id_closure_id_fkey"
  FOREIGN KEY ("tenant_id", "closure_id") REFERENCES "facility_closures"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- Only a cancellation by the system because the facility closed names one.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_closure"
  CHECK ("closure_id" IS NULL
      OR ("status" = 'cancelled' AND "cancelled_side" = 'system'
          AND "cancel_reason" = 'facility_closed'));

-- ----------------------------------------------------------------------------
-- Privileges and RLS. Nothing here is deleted.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "facility_closures" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "facility_closures" TO jiwar_app;

ALTER TABLE "facility_closures" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "facility_closures" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "facility_closures"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
