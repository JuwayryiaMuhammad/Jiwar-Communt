-- ============================================================================
-- Compliance (ADR 0087): a compliance item's evidence is a file purpose of
-- its own. The enum value is alone in its migration (a new value can't be
-- used in the transaction that adds it); the next migration recreates the
-- content type CHECK.
-- ============================================================================

ALTER TYPE "file_purpose" ADD VALUE 'compliance_evidence';
