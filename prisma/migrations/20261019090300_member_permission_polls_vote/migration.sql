-- ============================================================================
-- A household member may be given the unit's vote in the compound's
-- consultative polls (ADR 0040). Not granted by default: the primary gives
-- it. Alone in its migration, as every new enum value is.
-- ============================================================================

ALTER TYPE "member_permission" ADD VALUE 'polls_vote';
