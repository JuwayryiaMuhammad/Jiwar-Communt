-- ============================================================================
-- Patrols (ADR 0052): the file purpose of a patrol note's photos. Alone in
-- its migration: a new enum value cannot be used in the transaction that
-- adds it.
-- ============================================================================

ALTER TYPE "file_purpose" ADD VALUE 'patrol_photo';
