-- ============================================================================
-- Overnight guest rooms (ADR 0070). A `stay` facility has rooms (its
-- capacity, counted in bookings), a check-in and a check-out time (local
-- minutes after midnight), at most `max_nights` nights a booking, no slots,
-- no peaks, no approval, no companions and no waitlist. A stay booking names
-- its first night and its check-out day; its start and end are the check-in
-- and check-out instants in the compound's time zone. A night is full when
-- the stays covering it reach the rooms: a stay takes each of its nights'
-- lock rows FOR UPDATE, in ascending night order, before counting.
-- ============================================================================

ALTER TABLE "facilities" ADD COLUMN "check_in_minute" INTEGER;
ALTER TABLE "facilities" ADD COLUMN "check_out_minute" INTEGER;
ALTER TABLE "facilities" ADD COLUMN "max_nights" INTEGER;
ALTER TABLE "facilities" DROP CONSTRAINT "facilities_rules_shape";
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_rules_shape"
  CHECK (("mode" = 'bookable'
          AND "slot_minutes" IS NOT NULL AND "capacity" IS NOT NULL
          AND "capacity_unit" IS NOT NULL AND "max_days_ahead" IS NOT NULL
          AND "min_minutes_before" IS NOT NULL AND "cancel_cutoff_minutes" IS NOT NULL
          AND "max_guests" IS NOT NULL AND "weekly_quota" IS NOT NULL
          AND "peak_quota" IS NOT NULL
          AND "check_in_minute" IS NULL AND "check_out_minute" IS NULL
          AND "max_nights" IS NULL)
      OR ("mode" = 'walk_in'
          AND "slot_minutes" IS NULL AND "capacity" IS NULL
          AND "capacity_unit" IS NULL AND "max_days_ahead" IS NULL
          AND "min_minutes_before" IS NULL AND "cancel_cutoff_minutes" IS NULL
          AND "max_guests" IS NULL AND "weekly_quota" IS NULL
          AND "peak_quota" IS NULL
          AND "check_in_minute" IS NULL AND "check_out_minute" IS NULL
          AND "max_nights" IS NULL
          AND NOT "requires_approval" AND NOT "requires_membership")
      OR ("mode" = 'stay'
          AND "slot_minutes" IS NULL AND "capacity" IS NOT NULL
          AND "capacity_unit" IS NOT DISTINCT FROM 'bookings'
          AND "max_days_ahead" IS NOT NULL
          AND "min_minutes_before" IS NOT NULL AND "cancel_cutoff_minutes" IS NOT NULL
          AND "max_guests" IS NOT NULL AND "weekly_quota" IS NOT NULL
          AND "peak_quota" IS NOT NULL
          AND "check_in_minute" IS NOT NULL AND "check_out_minute" IS NOT NULL
          AND "max_nights" IS NOT NULL
          AND NOT "requires_approval" AND NOT "child_occasions"));
-- STAY_RANGES in src/facilities/setup/facility-rules.ts.
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_stay_ranges"
  CHECK (("check_in_minute" IS NULL OR "check_in_minute" BETWEEN 0 AND 1439)
     AND ("check_out_minute" IS NULL OR "check_out_minute" BETWEEN 0 AND 1439)
     AND ("max_nights" IS NULL OR "max_nights" BETWEEN 1 AND 14));

-- ----------------------------------------------------------------------------
-- A stay booking's nights: the first night and the check-out day (local
-- days), never changed (the trigger, below). Its window spans the nights.
-- ----------------------------------------------------------------------------
ALTER TABLE "bookings" ADD COLUMN "stay_from_on" DATE;
ALTER TABLE "bookings" ADD COLUMN "stay_to_on" DATE;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_stay"
  CHECK (("stay_from_on" IS NULL) = ("stay_to_on" IS NULL)
     AND ("stay_from_on" IS NULL
          OR ("stay_to_on" > "stay_from_on" AND "stay_to_on" <= "stay_from_on" + 14)));
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_window";
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_window"
  CHECK ("ends_at" > "starts_at"
     AND ("ends_at" <= "starts_at" + interval '8 hours'
          OR ("stay_from_on" IS NOT NULL AND "ends_at" <= "starts_at" + interval '15 days')));
CREATE INDEX "bookings_stay_idx" ON "bookings"("tenant_id", "facility_id", "stay_from_on")
  WHERE "stay_from_on" IS NOT NULL;

CREATE OR REPLACE FUNCTION booking_keeps_its_slot() RETURNS trigger
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
     AND NEW."created_at" = OLD."created_at"
     AND NEW."stay_from_on" IS NOT DISTINCT FROM OLD."stay_from_on"
     AND NEW."stay_to_on" IS NOT DISTINCT FROM OLD."stay_to_on" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'bookings: a booking keeps its slot and its party (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- ----------------------------------------------------------------------------
-- A night's lock row: a stay locks each of its nights, ascending, then
-- counts the stays covering them. It holds no count. One row per night ever
-- booked.
-- ----------------------------------------------------------------------------
CREATE TABLE "facility_night_locks" (
    "tenant_id" UUID NOT NULL,
    "facility_id" UUID NOT NULL,
    "night_on" DATE NOT NULL,
    CONSTRAINT "facility_night_locks_pkey" PRIMARY KEY ("tenant_id", "facility_id", "night_on")
);
ALTER TABLE "facility_night_locks" ADD CONSTRAINT "facility_night_locks_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "facility_night_locks" ADD CONSTRAINT "facility_night_locks_facility_fkey"
  FOREIGN KEY ("tenant_id", "facility_id") REFERENCES "facilities"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

REVOKE ALL ON "facility_night_locks" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "facility_night_locks" TO jiwar_app;
ALTER TABLE "facility_night_locks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "facility_night_locks" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "facility_night_locks"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
