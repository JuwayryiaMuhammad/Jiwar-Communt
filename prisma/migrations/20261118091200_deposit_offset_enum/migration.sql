-- ============================================================================
-- Deposits (ADR 0062): a deposit's deduction for unpaid dues pays them as an
-- office payment of its own method. Alone in its migration: a new enum
-- value cannot be used in the transaction that adds it.
-- ============================================================================

ALTER TYPE "payment_method" ADD VALUE 'deposit_offset';
