-- ============================================================================
-- Phase R1 — step-up (ADR 0036): a fresh one-time code before a sensitive
-- action. Its own purpose, so it can never log anyone in, accept an invite
-- or confirm a registration. Alone in its migration: a new enum value
-- cannot be used in the transaction that adds it.
-- ============================================================================

ALTER TYPE "otp_purpose" ADD VALUE 'step_up';
