-- ============================================================================
-- Children (ADR 0054) under a lockdown (ADR 0053).
-- ============================================================================
--
-- While a lockdown holds the guard's gate (that gate's, or every gate's),
-- an outside escort takes no child out: the exit is refused and recorded
-- with the reason `lockdown`. The household's adults and the unit's
-- workers are not refused. The CHECK on the reasons is recreated with it.

ALTER TABLE "child_pickups" DROP CONSTRAINT "child_pickups_refusal_reason";
ALTER TABLE "child_pickups" ADD CONSTRAINT "child_pickups_refusal_reason"
  CHECK ("refusal_reason" IS NULL OR "refusal_reason" IN (
    'not_an_escort', 'outside_validity', 'wrong_post', 'escort_inactive',
    'no_credential', 'alone_not_allowed', 'lockdown'));
