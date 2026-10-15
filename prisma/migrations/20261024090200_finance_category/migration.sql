-- ============================================================================
-- Phase R6a — finance (ADR 0046). The notification category of a unit's
-- invoices and payments. Alone in its migration: a new enum value cannot be
-- used in the transaction that adds it.
-- ============================================================================

ALTER TYPE "notification_category" ADD VALUE 'finance';
