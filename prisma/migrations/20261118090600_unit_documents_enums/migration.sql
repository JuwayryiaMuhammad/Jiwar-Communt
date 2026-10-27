-- ============================================================================
-- A unit's document vault (ADR 0062): the file purpose of a unit document,
-- and the `documents` delegation scope. Alone in their migration: a new enum
-- value cannot be used in the transaction that adds it.
-- ============================================================================

ALTER TYPE "file_purpose" ADD VALUE 'unit_document';
ALTER TYPE "delegation_scope" ADD VALUE 'documents';
