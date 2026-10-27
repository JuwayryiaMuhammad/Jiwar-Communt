-- ============================================================================
-- Proof of kinship and delegated permits (ADR 0062): the file purpose of an
-- invite's proof, and the `permits` delegation scope. Alone in their
-- migration: a new enum value cannot be used in the transaction that adds it.
-- ============================================================================

ALTER TYPE "file_purpose" ADD VALUE 'kinship_proof';
ALTER TYPE "delegation_scope" ADD VALUE 'permits';
