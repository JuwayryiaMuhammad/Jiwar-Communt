-- ============================================================================
-- A deferred suggestion (ADR 0080, amends ADR 0040): the management will not
-- take it up now and says why. Not final, so it may go on later; it carries
-- the answer the author was given, as a decline does.
-- ============================================================================

ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_deferred_answered"
  CHECK ("status" <> 'deferred' OR "response" IS NOT NULL);
