-- ============================================================================
-- Phase R1 — notification preferences (ADR 0036). An outbox message held by
-- a pause "until resumed" waits in its own status, which the processor never
-- claims. Alone in its migration: a new enum value cannot be used in the
-- transaction that adds it.
-- ============================================================================

ALTER TYPE "outbox_status" ADD VALUE 'held';
