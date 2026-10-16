-- ============================================================================
-- Phase R7a — governance: the board, votes and elections (ADR 0051): the
-- notification category `governance`. Alone in its migration: a new enum
-- value cannot be used in the transaction that adds it.
-- ============================================================================

ALTER TYPE "notification_category" ADD VALUE 'governance';
