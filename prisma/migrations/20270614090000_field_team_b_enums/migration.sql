-- ============================================================================
-- The field team, part b (ADR 0090): the file purpose of a staff member's
-- certificate, alone in its migration because a new enum value cannot be
-- used in the transaction that adds it. 20270614090500 recreates the files'
-- content type CHECK with it.
-- ============================================================================

ALTER TYPE "file_purpose" ADD VALUE 'staff_certificate';
