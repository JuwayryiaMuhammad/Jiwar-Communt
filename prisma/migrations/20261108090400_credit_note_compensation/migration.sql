-- ============================================================================
-- A compensation decision (ADR 0058): a credit note with the staff reason
-- `compensation` names why (a closed list), and nothing else does. The unit
-- is told of every credit note the staff issue, and of a compensation as
-- such.
-- ============================================================================

ALTER TABLE "credit_notes" ADD COLUMN "compensation_reason" TEXT;

-- REASON_CODES.creditNote + REASON_CODES.creditNoteSystem.
ALTER TABLE "credit_notes" DROP CONSTRAINT "credit_notes_reason";
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_reason"
  CHECK ("reason_code" IN ('billing_error', 'waiver', 'duplicate', 'goodwill', 'compensation', 'other', 'instalment_plan', 'dispute'));

-- REASON_CODES.creditNoteCompensation, exactly on a compensation.
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_compensation"
  CHECK (("reason_code" = 'compensation') = ("compensation_reason" IS NOT NULL)
     AND ("compensation_reason" IS NULL
          OR "compensation_reason" IN ('service_outage', 'maintenance_delay', 'facility_closure', 'other')));
