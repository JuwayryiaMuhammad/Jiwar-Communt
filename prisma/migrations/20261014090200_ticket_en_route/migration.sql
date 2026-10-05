-- ============================================================================
-- "Technician on the way" (ADR 0038): an en_route ticket is in the
-- technician's hands like an assigned one, so it has a technician.
-- ============================================================================

ALTER TABLE "tickets" DROP CONSTRAINT "tickets_technician_matches_status";
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_technician_matches_status"
  CHECK (("status" = 'new' AND "technician_account_id" IS NULL)
      OR ("status" IN ('assigned', 'en_route', 'in_progress', 'on_hold', 'completed', 'closed')
          AND "technician_account_id" IS NOT NULL)
      OR "status" = 'cancelled');
