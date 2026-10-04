-- ============================================================================
-- Phase 5.2 (ADR 0033): the dispatch engine breaks a tie between equally
-- loaded technicians by who was given a ticket longest ago, which reads
-- ticket_assignments by to_account_id. It had no index for that.
--
-- This is an index on a 5.1 table and nothing else: no column, constraint,
-- trigger, privilege or behaviour changes, so ADR 0032's promise that 5.2
-- changes none of its tables holds. It is its own migration so that the
-- one change to a 5.1 table is easy to find (and to drop).
-- ============================================================================
CREATE INDEX "ticket_assignments_to_account_idx"
  ON "ticket_assignments"("tenant_id", "to_account_id", "created_at");
