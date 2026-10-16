-- ============================================================================
-- Guard shifts and tasks (ADR 0050): the guards' work as a delivery category.
-- ============================================================================
--
-- On its own: a value added to an enum cannot be used in the transaction
-- that adds it.

ALTER TYPE "notification_category" ADD VALUE 'guard_duty';
