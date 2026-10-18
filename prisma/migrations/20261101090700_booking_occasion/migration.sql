-- ============================================================================
-- Children (ADR 0054, amends ADR 0044): a child as a booking's occasion.
-- ============================================================================
--
-- A bookable facility may take a child as the occasion of a booking (a
-- birthday space: `child_occasions`, set by the staff). A booking of it
-- may name one of the booking unit's minors; the household sees the
-- child's first name while the child is the unit's, the staff see only
-- that there is one. Which child never changes, like the slot.

ALTER TABLE "facilities"
  ADD COLUMN "child_occasions" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "facilities"
  ADD CONSTRAINT "facilities_child_occasions_bookable"
    CHECK ("mode" = 'bookable' OR NOT "child_occasions");

ALTER TABLE "bookings" ADD COLUMN "occasion_member_id" UUID;
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_tenant_id_occasion_member_id_fkey"
    FOREIGN KEY ("tenant_id", "occasion_member_id") REFERENCES "household_members"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION booking_keeps_its_occasion() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."occasion_member_id" IS NOT DISTINCT FROM OLD."occasion_member_id" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'bookings: a booking keeps its occasion'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER bookings_keep_occasion
  BEFORE UPDATE ON "bookings"
  FOR EACH ROW EXECUTE FUNCTION booking_keeps_its_occasion();
