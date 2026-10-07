-- ============================================================================
-- Two ratings at confirmation (ADR 0038): `rating` stays the service's;
-- `technician_rating` rates the technician who did the work, named on the
-- row (`rated_technician_account_id`) so a later reassignment never moves
-- it. Optional: a confirmation without it is the 5.1 one. Like `rating`,
-- for dispatch only; the technician never sees ratings (ADR 0032).
-- ============================================================================

ALTER TABLE "ticket_feedback"
  ADD COLUMN "technician_rating" INTEGER,
  -- A pointer: an erased technician stays a tombstone.
  ADD COLUMN "rated_technician_account_id" UUID;

ALTER TABLE "ticket_feedback" ADD CONSTRAINT "ticket_feedback_technician_rating_shape"
  CHECK (("technician_rating" IS NULL) = ("rated_technician_account_id" IS NULL)
     AND ("technician_rating" IS NULL
          OR ("kind" = 'confirmed' AND "technician_rating" BETWEEN 1 AND 5)));

