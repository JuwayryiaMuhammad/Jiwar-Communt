-- ============================================================================
-- Contracts (ADR 0062): the file purpose of a contract's scan. Alone in its
-- migration: a new enum value cannot be used in the transaction that adds it.
-- ============================================================================

ALTER TYPE "file_purpose" ADD VALUE 'contract';
