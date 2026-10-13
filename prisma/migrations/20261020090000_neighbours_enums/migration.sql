-- ============================================================================
-- Phase R4 — neighbours (ADR 0042). Three enum values the next migrations
-- use: the notification category of what happens between units, and the
-- file purposes of a complaint's evidence and of a board post's photos.
-- Alone in their migration: a new enum value cannot be used in the
-- transaction that adds it.
-- ============================================================================

ALTER TYPE "notification_category" ADD VALUE 'neighbours';
ALTER TYPE "file_purpose" ADD VALUE 'complaint_evidence';
ALTER TYPE "file_purpose" ADD VALUE 'neighbour_post_photo';
