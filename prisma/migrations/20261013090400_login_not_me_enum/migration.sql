-- ============================================================================
-- Phase R1 — "not me" on an unusual login (ADR 0036): a freeze that keeps
-- the phone. Alone in its migration: a new enum value cannot be used in the
-- transaction that adds it.
-- ============================================================================

ALTER TYPE "account_freeze_reason" ADD VALUE 'login_not_me';
