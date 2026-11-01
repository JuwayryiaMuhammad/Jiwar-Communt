-- ============================================================================
-- Dispatch depth (ADR 0076): the enum value the phase uses, alone in its
-- migration because a new enum value cannot be used in the transaction that
-- adds it.
--
-- `closed_by_staff`: a resident's completed ticket that dispatch closed on
-- the residents' behalf (they confirmed by phone, could not be reached, left
-- the compound), with a reason code. Neither a confirmation nor a silence.
-- ============================================================================

ALTER TYPE "ticket_confirmation_status" ADD VALUE 'closed_by_staff';
