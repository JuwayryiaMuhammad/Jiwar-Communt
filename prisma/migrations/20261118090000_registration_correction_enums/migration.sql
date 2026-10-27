-- ============================================================================
-- Registration documents and corrections (ADR 0062): a request the
-- management sent back for a correction, and the purpose of the documents a
-- registrant uploads. Alone in their migration: a new enum value cannot be
-- used in the transaction that adds it.
-- ============================================================================

ALTER TYPE "registration_status" ADD VALUE 'needs_correction';
ALTER TYPE "file_purpose" ADD VALUE 'registration_document';
