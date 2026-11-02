-- ============================================================================
-- Announcements and the office queue (ADR 0080): the enum value the phase
-- uses, alone in its migration because a new enum value cannot be used in
-- the transaction that adds it.
--
-- `deferred`: a suggestion the management will not take up now, with its
-- answer to the author. Not final: it may be taken up again later.
-- ============================================================================

ALTER TYPE "suggestion_status" ADD VALUE 'deferred' BEFORE 'done';
