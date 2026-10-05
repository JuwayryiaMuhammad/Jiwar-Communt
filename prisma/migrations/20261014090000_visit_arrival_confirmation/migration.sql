-- ============================================================================
-- The residents confirm the technician's arrival (ADR 0038).
--
-- The technician marks the arrival (`arrived`); someone on the residents'
-- side says they are really at the door. Once per visit, while it is
-- `arrived`, never before: the shape CHECK ties the two columns together
-- and to an arrival.
--
-- The enum value is not used in this migration, so it may be added here.
-- ============================================================================

ALTER TYPE "visit_event_kind" ADD VALUE 'arrival_confirmed';

ALTER TABLE "ticket_visits"
  ADD COLUMN "arrival_confirmed_at" TIMESTAMPTZ(3),
  -- A pointer like the others: an erased account stays a tombstone.
  ADD COLUMN "arrival_confirmed_by_account_id" UUID;

ALTER TABLE "ticket_visits" ADD CONSTRAINT "ticket_visits_arrival_confirmed_shape"
  CHECK (("arrival_confirmed_at" IS NULL) = ("arrival_confirmed_by_account_id" IS NULL)
     AND ("arrival_confirmed_at" IS NULL OR "arrived_at" IS NOT NULL));
