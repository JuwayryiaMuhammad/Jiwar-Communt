-- ============================================================================
-- Phase R5 — bookings (ADR 0044). A unit's booking of a facility's slot, and
-- the lock rows a booking takes. No free text: reasons are codes.
-- ============================================================================

CREATE TYPE "booking_status" AS ENUM ('pending', 'confirmed', 'rejected', 'cancelled', 'no_show');
CREATE TYPE "booking_side" AS ENUM ('resident', 'staff', 'system');

-- ----------------------------------------------------------------------------
-- A slot's lock row: a booking locks it, then counts what holds the
-- slot's window. It holds no count.
-- ----------------------------------------------------------------------------
CREATE TABLE "facility_slot_locks" (
    "tenant_id" UUID NOT NULL,
    "facility_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "facility_slot_locks_pkey" PRIMARY KEY ("tenant_id", "facility_id", "starts_at")
);
ALTER TABLE "facility_slot_locks" ADD CONSTRAINT "facility_slot_locks_tenant_id_facility_id_fkey"
  FOREIGN KEY ("tenant_id", "facility_id") REFERENCES "facilities"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ----------------------------------------------------------------------------
-- Bookings. HOLDING = pending or confirmed: what takes a place in a slot.
-- COUNTED = HOLDING and no_show: what counts towards a unit's quota.
-- ----------------------------------------------------------------------------
CREATE TABLE "bookings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "facility_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "booked_by_account_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "guests" INTEGER NOT NULL,
    "party_size" INTEGER NOT NULL,
    "peak" BOOLEAN NOT NULL,
    "status" "booking_status" NOT NULL,
    "decided_by_account_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "reject_reason" TEXT,
    "cancelled_side" "booking_side",
    "cancel_reason" TEXT,
    "cancelled_by_account_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "no_show_marked_by_account_id" UUID,
    "no_show_marked_at" TIMESTAMPTZ(3),
    "reminded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bookings_tenant_id_id_key" ON "bookings"("tenant_id", "id");
-- A unit holds a slot once.
CREATE UNIQUE INDEX "bookings_one_holding_per_unit_slot"
  ON "bookings"("tenant_id", "facility_id", "unit_id", "starts_at")
  WHERE "status" IN ('pending', 'confirmed');
CREATE INDEX "bookings_unit_idx" ON "bookings"("tenant_id", "unit_id", "starts_at", "id");
CREATE INDEX "bookings_booker_idx" ON "bookings"("tenant_id", "booked_by_account_id", "starts_at", "id");
CREATE INDEX "bookings_facility_idx" ON "bookings"("tenant_id", "facility_id", "starts_at", "id");
CREATE INDEX "bookings_status_idx" ON "bookings"("tenant_id", "status", "starts_at", "id");

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "bookings_tenant_id_facility_id_fkey"
  FOREIGN KEY ("tenant_id", "facility_id") REFERENCES "facilities"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "bookings_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "bookings_tenant_id_booked_by_fkey"
  FOREIGN KEY ("tenant_id", "booked_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "bookings_tenant_id_decided_by_fkey"
  FOREIGN KEY ("tenant_id", "decided_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "bookings_tenant_id_cancelled_by_fkey"
  FOREIGN KEY ("tenant_id", "cancelled_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "bookings_tenant_id_no_show_by_fkey"
  FOREIGN KEY ("tenant_id", "no_show_marked_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A slot lasts at most eight hours (the longest slot a facility takes).
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_window"
  CHECK ("ends_at" > "starts_at" AND "ends_at" <= "starts_at" + interval '8 hours');
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_party"
  CHECK ("guests" BETWEEN 0 AND 50 AND "party_size" = "guests" + 1);
-- Each status sets exactly its own columns. A confirmed booking was decided
-- by the staff (approved) or by nobody (confirmed at once); a cancelled one
-- may have been approved first. Nullable columns appear only under
-- IS [NOT] NULL; the reasons' lists are their own CHECKs below.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_state_shape"
  CHECK (("decided_at" IS NULL) = ("decided_by_account_id" IS NULL)
     AND ("no_show_marked_at" IS NULL) = ("no_show_marked_by_account_id" IS NULL)
     AND ("cancelled_at" IS NULL) = ("cancelled_side" IS NULL)
     AND ("cancelled_at" IS NULL) = ("cancel_reason" IS NULL)
     AND ("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
     AND ("status" = 'rejected') = ("reject_reason" IS NOT NULL)
     AND ("status" = 'no_show') = ("no_show_marked_at" IS NOT NULL)
     AND ("status" <> 'pending' OR "decided_at" IS NULL)
     AND ("status" <> 'rejected' OR "decided_at" IS NOT NULL)
     AND ("cancelled_by_account_id" IS NULL OR "cancelled_at" IS NOT NULL));
-- The system cancels by nobody; a resident or a staff member by themselves.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cancelled_by"
  CHECK ("cancelled_side" IS NULL
      OR ("cancelled_side" = 'system') = ("cancelled_by_account_id" IS NULL));
-- The reason lists (REASON_CODES in src/core/common/reasons.ts; a unit test
-- keeps the two in step).
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cancel_reason"
  CHECK ("cancel_reason" IS NULL
      OR ("cancelled_side" = 'resident' AND "cancel_reason" IN ('no_longer_needed', 'cannot_attend', 'other'))
      OR ("cancelled_side" = 'staff' AND "cancel_reason" IN ('facility_unavailable', 'rules_violation', 'resident_request', 'other'))
      OR ("cancelled_side" = 'system' AND "cancel_reason" IN ('facility_closed', 'approval_expired', 'booker_left')));
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_reject_reason"
  CHECK ("reject_reason" IS NULL
      OR "reject_reason" IN ('slot_unavailable', 'not_eligible', 'rules_violation', 'other'));

-- What a booking is never rewritten in: its facility, unit, booker, times
-- and party. Its status moves; it is never deleted.
CREATE FUNCTION booking_keeps_its_slot() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."facility_id" = OLD."facility_id"
     AND NEW."unit_id" = OLD."unit_id"
     AND NEW."booked_by_account_id" = OLD."booked_by_account_id"
     AND NEW."starts_at" = OLD."starts_at"
     AND NEW."ends_at" = OLD."ends_at"
     AND NEW."guests" = OLD."guests"
     AND NEW."party_size" = OLD."party_size"
     AND NEW."peak" = OLD."peak"
     AND NEW."created_at" = OLD."created_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'bookings: a booking keeps its slot and its party (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER bookings_keep_slot
  BEFORE UPDATE OR DELETE ON "bookings"
  FOR EACH ROW EXECUTE FUNCTION booking_keeps_its_slot();
CREATE TRIGGER bookings_keep_slot_truncate
  BEFORE TRUNCATE ON "bookings"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Privileges and RLS. Nothing here is deleted. A lock row is locked FOR
-- UPDATE, which needs UPDATE.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "facility_slot_locks", "bookings" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "facility_slot_locks", "bookings" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['facility_slot_locks', 'bookings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
