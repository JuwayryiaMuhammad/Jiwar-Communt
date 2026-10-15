-- ============================================================================
-- Phase R6b — invoice disputes (ADR 0048): the file purpose of a resident's
-- photo that backs a dispute. Alone in its migration: a new enum value cannot
-- be used in the transaction that adds it.
-- ============================================================================

ALTER TYPE "file_purpose" ADD VALUE 'dispute_photo';
