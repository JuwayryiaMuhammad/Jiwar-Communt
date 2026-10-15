-- ============================================================================
-- Vehicles and parking (ADR 0045): a unit's own parking slots, the
-- compound's visitor parking areas, and the bookings residents make there
-- for a visitor.
--
-- A slot is configuration (a code, a place), kept by the staff; the audit
-- keeps its history. An area is never deleted; it is retired with
-- `active`. A booking holds one space of an area for a window (at most a
-- day, the compound's setting below that), for a visitor pass of the unit
-- or a visitor's name; it is cancelled once (by its booker or the unit's
-- primary, by the staff with a reason code, or by the system when its
-- pass is cancelled or its booker leaves) and never rewritten. The
-- visitor's name is deleted 30 days after the booking ends.
-- ============================================================================

CREATE TYPE "visitor_parking_status" AS ENUM ('confirmed', 'cancelled');
CREATE TYPE "visitor_parking_cancel_side" AS ENUM ('resident', 'staff', 'system');

-- ----------------------------------------------------------------------------
-- A unit's own parking slots.
-- ----------------------------------------------------------------------------
CREATE TABLE "unit_parking_slots" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "place" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "unit_parking_slots_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "unit_parking_slots_tenant_id_id_key" ON "unit_parking_slots"("tenant_id", "id");
CREATE UNIQUE INDEX "unit_parking_slots_code_key" ON "unit_parking_slots"("tenant_id", "code");
CREATE INDEX "unit_parking_slots_unit_idx" ON "unit_parking_slots"("tenant_id", "unit_id", "code");
ALTER TABLE "unit_parking_slots"
  ADD CONSTRAINT "unit_parking_slots_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_parking_slots_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "unit_parking_slots" ADD CONSTRAINT "unit_parking_slots_text_length"
  CHECK (char_length("code") BETWEEN 1 AND 20 AND char_length("place") BETWEEN 1 AND 80);

-- ----------------------------------------------------------------------------
-- Visitor parking areas.
-- ----------------------------------------------------------------------------
CREATE TABLE "visitor_parking_areas" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "visitor_parking_areas_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "visitor_parking_areas_tenant_id_id_key" ON "visitor_parking_areas"("tenant_id", "id");
CREATE UNIQUE INDEX "visitor_parking_areas_name_key" ON "visitor_parking_areas"("tenant_id", "name");
ALTER TABLE "visitor_parking_areas" ADD CONSTRAINT "visitor_parking_areas_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "visitor_parking_areas" ADD CONSTRAINT "visitor_parking_areas_name_length"
  CHECK (char_length("name") BETWEEN 1 AND 60);
ALTER TABLE "visitor_parking_areas" ADD CONSTRAINT "visitor_parking_areas_capacity"
  CHECK ("capacity" BETWEEN 1 AND 500);

-- ----------------------------------------------------------------------------
-- Visitor parking bookings.
-- ----------------------------------------------------------------------------
CREATE TABLE "visitor_parking_bookings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "unit_id" UUID NOT NULL,
    "area_id" UUID NOT NULL,
    "visitor_pass_id" UUID,
    "visitor_name" TEXT,
    "visitor_name_cleared_at" TIMESTAMPTZ(3),
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "visitor_parking_status" NOT NULL DEFAULT 'confirmed',
    "booked_by_account_id" UUID NOT NULL,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_account_id" UUID,
    "cancel_side" "visitor_parking_cancel_side",
    "cancel_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "visitor_parking_bookings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "visitor_parking_bookings_tenant_id_id_key" ON "visitor_parking_bookings"("tenant_id", "id");
CREATE UNIQUE INDEX "visitor_parking_bookings_number_key" ON "visitor_parking_bookings"("tenant_id", "number");
-- What holds an area: the capacity check reads it under the area's lock.
CREATE INDEX "visitor_parking_bookings_area_idx"
  ON "visitor_parking_bookings"("tenant_id", "area_id", "starts_at", "ends_at")
  WHERE "status" = 'confirmed';
CREATE INDEX "visitor_parking_bookings_unit_idx"
  ON "visitor_parking_bookings"("tenant_id", "unit_id", "starts_at", "id");
CREATE INDEX "visitor_parking_bookings_pass_idx"
  ON "visitor_parking_bookings"("tenant_id", "visitor_pass_id")
  WHERE "visitor_pass_id" IS NOT NULL;
CREATE INDEX "visitor_parking_bookings_booker_idx"
  ON "visitor_parking_bookings"("tenant_id", "booked_by_account_id", "ends_at");
-- The visitors' names the sweep deletes 30 days after the end.
CREATE INDEX "visitor_parking_bookings_name_due_idx"
  ON "visitor_parking_bookings"("tenant_id", "ends_at")
  WHERE "visitor_name" IS NOT NULL;
ALTER TABLE "visitor_parking_bookings"
  ADD CONSTRAINT "visitor_parking_bookings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "visitor_parking_bookings_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "visitor_parking_bookings_tenant_id_area_id_fkey"
  FOREIGN KEY ("tenant_id", "area_id") REFERENCES "visitor_parking_areas"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "visitor_parking_bookings_tenant_id_visitor_pass_id_fkey"
  FOREIGN KEY ("tenant_id", "visitor_pass_id") REFERENCES "visitor_passes"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "visitor_parking_bookings_tenant_id_booked_by_fkey"
  FOREIGN KEY ("tenant_id", "booked_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "visitor_parking_bookings_tenant_id_cancelled_by_fkey"
  FOREIGN KEY ("tenant_id", "cancelled_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "visitor_parking_bookings" ADD CONSTRAINT "visitor_parking_bookings_number_positive"
  CHECK ("number" > 0);
ALTER TABLE "visitor_parking_bookings" ADD CONSTRAINT "visitor_parking_bookings_window"
  CHECK ("ends_at" > "starts_at" AND "ends_at" <= "starts_at" + interval '24 hours');
-- For a pass or a name, never both; the name may have gone with retention.
ALTER TABLE "visitor_parking_bookings" ADD CONSTRAINT "visitor_parking_bookings_visitor"
  CHECK (("visitor_pass_id" IS NULL) = ("visitor_name" IS NOT NULL OR "visitor_name_cleared_at" IS NOT NULL)
     AND ("visitor_name" IS NULL OR "visitor_name_cleared_at" IS NULL));
ALTER TABLE "visitor_parking_bookings" ADD CONSTRAINT "visitor_parking_bookings_visitor_name_length"
  CHECK ("visitor_name" IS NULL OR char_length("visitor_name") BETWEEN 1 AND 80);
-- Nullable columns only under IS [NOT] NULL; status is NOT NULL.
ALTER TABLE "visitor_parking_bookings" ADD CONSTRAINT "visitor_parking_bookings_state_shape"
  CHECK (("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
     AND ("cancelled_at" IS NULL) = ("cancel_side" IS NULL)
     AND ("cancelled_at" IS NULL) = ("cancel_reason" IS NULL));
ALTER TABLE "visitor_parking_bookings" ADD CONSTRAINT "visitor_parking_bookings_cancelled_by"
  CHECK ("cancel_side" IS NULL
      OR ("cancel_side" = 'system') = ("cancelled_by_account_id" IS NULL));
-- REASON_CODES.visitorParkingResidentCancel, visitorParkingStaffCancel,
-- visitorParkingSystemCancel, by side; a unit test keeps them in step.
ALTER TABLE "visitor_parking_bookings" ADD CONSTRAINT "visitor_parking_bookings_cancel_reason"
  CHECK ("cancel_reason" IS NULL
      OR ("cancel_side" = 'resident' AND "cancel_reason" IN ('no_longer_needed'))
      OR ("cancel_side" = 'staff' AND "cancel_reason" IN ('area_closed', 'misuse', 'other'))
      OR ("cancel_side" = 'system' AND "cancel_reason" IN ('pass_cancelled', 'booker_left')));

CREATE FUNCTION visitor_parking_booking_keeps_its_window() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number"
     AND NEW."unit_id" = OLD."unit_id"
     AND NEW."area_id" = OLD."area_id"
     AND NEW."visitor_pass_id" IS NOT DISTINCT FROM OLD."visitor_pass_id"
     AND NEW."starts_at" = OLD."starts_at"
     AND NEW."ends_at" = OLD."ends_at"
     AND NEW."booked_by_account_id" = OLD."booked_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     -- The name stays, or goes once (retention or erasure).
     AND (NEW."visitor_name" IS NOT DISTINCT FROM OLD."visitor_name"
          AND NEW."visitor_name_cleared_at" IS NOT DISTINCT FROM OLD."visitor_name_cleared_at"
          OR (OLD."visitor_name" IS NOT NULL AND NEW."visitor_name" IS NULL
              AND NEW."visitor_name_cleared_at" IS NOT NULL))
     -- Cancelled once, never rewritten.
     AND ((NEW."status" = OLD."status"
           AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at"
           AND NEW."cancelled_by_account_id" IS NOT DISTINCT FROM OLD."cancelled_by_account_id"
           AND NEW."cancel_side" IS NOT DISTINCT FROM OLD."cancel_side"
           AND NEW."cancel_reason" IS NOT DISTINCT FROM OLD."cancel_reason")
          OR OLD."status" = 'confirmed') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'visitor_parking_bookings: a booking keeps its window and is cancelled once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER visitor_parking_bookings_keep_window
  BEFORE UPDATE OR DELETE ON "visitor_parking_bookings"
  FOR EACH ROW EXECUTE FUNCTION visitor_parking_booking_keeps_its_window();
CREATE TRIGGER visitor_parking_bookings_keep_window_truncate
  BEFORE TRUNCATE ON "visitor_parking_bookings"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Privileges and RLS. Slots are deleted; areas and bookings never are.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "unit_parking_slots", "visitor_parking_areas", "visitor_parking_bookings" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "unit_parking_slots" TO jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "visitor_parking_areas", "visitor_parking_bookings" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['unit_parking_slots', 'visitor_parking_areas',
                           'visitor_parking_bookings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
