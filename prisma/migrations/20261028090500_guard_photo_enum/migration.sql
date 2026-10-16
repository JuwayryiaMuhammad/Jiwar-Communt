-- ============================================================================
-- Guard shifts and tasks (ADR 0050): the file purposes of a task's photos
-- (a closed unit inspected, a custom task done) and of a found item's.
-- Alone in its migration: a new enum value cannot be used in the
-- transaction that adds it.
-- ============================================================================

ALTER TYPE "file_purpose" ADD VALUE 'guard_task_photo';
ALTER TYPE "file_purpose" ADD VALUE 'found_item_photo';
