-- ============================================================================
-- Phase R6b — finance part 2 (ADR 0048). Whether an allocation came from
-- money the unit already held as credit, or was written in the transaction
-- that took the payment. The ledger's "credit applied" rows are the former.
--
-- Neither created_at (Prisma stamps it in the app, per query) nor xmin (it
-- wraps) can tell the two apart afterwards, so the allocator records it.
-- A constant default only changes the catalogue: no row is rewritten and the
-- append-only row triggers do not fire. Allocations written before R6b keep
-- false (ADR 0048).
-- ============================================================================

ALTER TABLE "finance_allocations"
  ADD COLUMN "from_credit" BOOLEAN NOT NULL DEFAULT false;
