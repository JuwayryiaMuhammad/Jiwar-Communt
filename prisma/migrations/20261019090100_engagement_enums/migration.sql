-- ============================================================================
-- Phase R3 — community life (ADR 0040). Two enum values the next migrations
-- use: the notification category of the community's notices and the file
-- purpose of what the staff attach to an announcement, an event or a "we
-- did" note. Alone in their migration: a new enum value cannot be used in
-- the transaction that adds it.
-- ============================================================================

ALTER TYPE "notification_category" ADD VALUE 'community';
ALTER TYPE "file_purpose" ADD VALUE 'community_attachment';
