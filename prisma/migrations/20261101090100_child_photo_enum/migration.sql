-- ============================================================================
-- Children (ADR 0054): the file purposes of a child's photo and of an
-- outside escort's photo. Alone in their migration: a new enum value
-- cannot be used in the transaction that adds it.
-- ============================================================================

ALTER TYPE "file_purpose" ADD VALUE 'child_photo';
ALTER TYPE "file_purpose" ADD VALUE 'child_escort_photo';
