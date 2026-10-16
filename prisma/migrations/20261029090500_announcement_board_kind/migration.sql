-- ============================================================================
-- Phase R7a — the board's decisions and minutes reach the owners as
-- announcements of their own kind (ADR 0051). Alone in its migration: a new
-- enum value cannot be used in the transaction that adds it.
-- ============================================================================

ALTER TYPE "announcement_kind" ADD VALUE 'board';
