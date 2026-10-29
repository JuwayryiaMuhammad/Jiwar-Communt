-- ============================================================================
-- Energy and utilities (ADR 0066). The notification category of a utility
-- outage told to the residents of its buildings, so a resident may choose
-- how it reaches them. Alone in its migration: a new enum value cannot be
-- used in the transaction that adds it.
-- ============================================================================

ALTER TYPE "notification_category" ADD VALUE 'utilities';
