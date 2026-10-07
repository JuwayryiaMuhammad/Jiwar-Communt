-- ============================================================================
-- Where in the unit (ADR 0038): the room a report is about, picked from a
-- short list on "New report" and shown to whoever comes to fix it. Optional:
-- a ticket without it is the 5.1 one. A common area has no rooms, so the
-- CHECK allows it on a unit's ticket only.
-- ============================================================================

CREATE TYPE "ticket_unit_location" AS ENUM (
  'kitchen', 'bathroom', 'living_room', 'bedroom', 'balcony', 'other');

ALTER TABLE "tickets" ADD COLUMN "unit_location" "ticket_unit_location";

ALTER TABLE "tickets" ADD CONSTRAINT "tickets_unit_location_unit_only"
  CHECK ("unit_location" IS NULL OR "unit_id" IS NOT NULL);
