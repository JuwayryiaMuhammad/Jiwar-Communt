-- ============================================================================
-- Phase R6a — step-up for platform sessions (ADR 0046). A fresh code emailed
-- to the platform admin opens one sensitive action (a compound's payment
-- gateway) on the session that asked, for ten minutes, like
-- sessions.step_up_until (ADR 0036).
-- ============================================================================

ALTER TABLE "platform_sessions" ADD COLUMN "step_up_until" TIMESTAMPTZ(3);
