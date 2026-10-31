-- ============================================================================
-- Priority rebook after a closure (ADR 0070): a booking a closure cancelled
-- may be booked again, once, at the same facility, for 72 hours after it was
-- cancelled — the unit's weekly and peak quotas skipped that once. The new
-- booking points at the one it replaces (once per booking: a unique key).
-- Both never change (the booking's trigger lets them be set once).
-- ============================================================================

ALTER TABLE "bookings" ADD COLUMN "rebook_until" TIMESTAMPTZ(3);
ALTER TABLE "bookings" ADD COLUMN "rebook_of_id" UUID;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_rebook_of_fkey"
  FOREIGN KEY ("tenant_id", "rebook_of_id") REFERENCES "bookings"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE UNIQUE INDEX "bookings_rebook_of_key" ON "bookings"("tenant_id", "rebook_of_id");
-- Only a closure's cancel offers a rebook.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_rebook"
  CHECK ("rebook_until" IS NULL OR "closure_id" IS NOT NULL);

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
     AND NEW."stay_to_on" IS NOT DISTINCT FROM OLD."stay_to_on"
     AND NEW."rebook_of_id" IS NOT DISTINCT FROM OLD."rebook_of_id"
     AND (NEW."rebook_until" IS NOT DISTINCT FROM OLD."rebook_until"
          OR OLD."rebook_until" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'bookings: a booking keeps its slot and its party (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
