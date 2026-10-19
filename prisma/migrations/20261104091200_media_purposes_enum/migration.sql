-- ============================================================================
-- Recordings (ADR 0056): their file purposes. Alone in their migration: a
-- new enum value cannot be used in the transaction that adds it.
-- ============================================================================

ALTER TYPE "file_purpose" ADD VALUE 'patrol_note_audio';
ALTER TYPE "file_purpose" ADD VALUE 'patrol_note_video';
ALTER TYPE "file_purpose" ADD VALUE 'incident_audio';
ALTER TYPE "file_purpose" ADD VALUE 'incident_video';
