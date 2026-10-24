-- ============================================================================
-- Phase P1 — partners (ADR 0060). The notification category of a resident's
-- requests to the compound's service partners. Alone in its migration: a
-- new enum value cannot be used in the transaction that adds it.
-- ============================================================================

ALTER TYPE "notification_category" ADD VALUE 'partners';
