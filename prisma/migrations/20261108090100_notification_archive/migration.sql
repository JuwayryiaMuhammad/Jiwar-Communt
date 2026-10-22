-- ============================================================================
-- The resident's inbox (ADR 0058): a notification is archived (out of the
-- list, kept until the read retention takes it) or deleted by its holder.
-- An archived notification is a read one. Formal notices never live here:
-- their record and its proofs are their own (formal_notices).
-- ============================================================================

ALTER TABLE "notifications" ADD COLUMN "archived_at" TIMESTAMPTZ(3);
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_archived_is_read"
  CHECK ("archived_at" IS NULL OR "read_at" IS NOT NULL);
