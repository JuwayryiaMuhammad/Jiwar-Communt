-- ============================================================================
-- The visitor's photo at entry (ADR 0056): its file purpose. Alone in its
-- migration: a new enum value cannot be used in the transaction that adds it.
-- ============================================================================

ALTER TYPE "file_purpose" ADD VALUE 'visitor_photo';
