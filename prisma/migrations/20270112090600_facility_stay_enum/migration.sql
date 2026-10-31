-- ============================================================================
-- Overnight guest rooms (ADR 0070): a facility of the mode `stay` is booked
-- by the night, not by the slot. Alone in its migration: a new enum value
-- cannot be used in the transaction that adds it.
-- ============================================================================

ALTER TYPE "facility_mode" ADD VALUE 'stay';
