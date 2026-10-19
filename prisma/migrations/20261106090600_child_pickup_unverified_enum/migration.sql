-- ============================================================================
-- A child released offline whose escort the server cannot verify at sync
-- (ADR 0057): neither picked up by an escort nor refused. The enum value
-- alone: a new value cannot be used in the transaction that adds it.
-- ============================================================================
ALTER TYPE "child_pickup_outcome" ADD VALUE 'left_unverified';
