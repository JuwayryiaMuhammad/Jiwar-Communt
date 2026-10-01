-- The NULL trap (see test/db/check-constraints): `decided_by IS NULL OR
-- decision_source = 'household'` passes when decision_source is NULL. A
-- decider with no source must fail.
ALTER TABLE "gate_approval_requests" DROP CONSTRAINT "gate_approval_requests_decider_is_household";
ALTER TABLE "gate_approval_requests" ADD CONSTRAINT "gate_approval_requests_decider_is_household"
  CHECK ("decided_by" IS NULL OR COALESCE("decision_source" = 'household', false));
