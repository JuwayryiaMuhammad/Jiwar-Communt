-- ============================================================================
-- Decision appeals (ADR 0059): the file purpose of an appeal's attachments.
-- Alone in its migration: a new enum value cannot be used in the
-- transaction that adds it.
-- ============================================================================

ALTER TYPE "file_purpose" ADD VALUE 'decision_appeal_attachment';
