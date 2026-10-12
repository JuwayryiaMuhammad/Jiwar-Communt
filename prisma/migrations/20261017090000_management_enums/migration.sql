-- ============================================================================
-- Phase R2 — talking to management (ADR 0039). Two enum values the next
-- migration uses: the notification category of a management request and the
-- file purpose of a message's attachment. Alone in their migration: a new
-- enum value cannot be used in the transaction that adds it.
-- ============================================================================

ALTER TYPE "notification_category" ADD VALUE 'management';
ALTER TYPE "file_purpose" ADD VALUE 'request_attachment';
