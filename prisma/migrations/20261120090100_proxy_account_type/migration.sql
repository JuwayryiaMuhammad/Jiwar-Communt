-- ============================================================================
-- A unit proxy's account (ADR 0063): a fifth capacity, separate like the
-- others (ADR 0002): an outside person an owner trusts with a closed or
-- vacant unit. Alone in its migration: a new enum value is not usable in
-- the transaction that adds it.
-- ============================================================================
ALTER TYPE "account_type" ADD VALUE 'proxy';
-- The code that accepts a proxy invite, sent to the invited email.
ALTER TYPE "otp_purpose" ADD VALUE 'proxy_accept';
