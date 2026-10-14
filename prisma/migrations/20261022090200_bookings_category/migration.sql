-- ============================================================================
-- Phase R5 — bookings (ADR 0044). The notification category of a resident's
-- bookings and the club. Alone in its migration: a new enum value cannot be
-- used in the transaction that adds it.
-- ============================================================================

ALTER TYPE "notification_category" ADD VALUE 'bookings';
