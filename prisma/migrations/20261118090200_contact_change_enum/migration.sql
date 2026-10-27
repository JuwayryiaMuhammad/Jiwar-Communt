-- ============================================================================
-- An account's own email change (ADR 0062): the code that proves the new
-- address. Alone in its migration: a new enum value cannot be used in the
-- transaction that adds it.
-- ============================================================================

ALTER TYPE "otp_purpose" ADD VALUE 'contact_change';
