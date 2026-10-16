-- ============================================================================
-- Phase G3 — permits and contractors (ADR 0049): the notification category
-- `permits`, and the file purposes of a contractor worker's face and of a
-- material exit's photo. Alone in their migration: a new enum value cannot be
-- used in the transaction that adds it.
-- ============================================================================

ALTER TYPE "notification_category" ADD VALUE 'permits';
ALTER TYPE "file_purpose" ADD VALUE 'contractor_photo';
ALTER TYPE "file_purpose" ADD VALUE 'permit_photo';
