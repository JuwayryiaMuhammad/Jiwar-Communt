-- ============================================================================
-- Phase R1 — step-up (ADR 0036). A verified step-up code is bound to the
-- session that asked for it: the next sensitive action on that session may
-- run until `step_up_until`, and consumes it. `sessions` stays global.
-- ============================================================================

ALTER TABLE "sessions" ADD COLUMN "step_up_until" TIMESTAMPTZ(3);
