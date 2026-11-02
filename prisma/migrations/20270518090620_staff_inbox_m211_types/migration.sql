-- ============================================================================
-- The staff inbox (ADR 0073) gathers three more types (ADR 0083): an
-- ownership transfer to approve, a closed unit's round to schedule, and an
-- emergency entry's report to write. Both type CHECKs are recreated with
-- every type, dated after every migration that recreates them
-- (20270518090600 the last), so a fresh database and an existing one both
-- end with all of them. No row changes.
-- ============================================================================
ALTER TABLE "staff_inbox_due_hours" DROP CONSTRAINT "staff_inbox_due_hours_type";
ALTER TABLE "staff_inbox_due_hours" ADD CONSTRAINT "staff_inbox_due_hours_type"
  CHECK ("type" IN ('registration', 'identity_change', 'worker_engagement', 'vehicle',
    'booking', 'unit_permit', 'work_permit', 'field_exception', 'plan_request',
    'invoice_dispute', 'decision_appeal', 'management_request', 'purchase_request', 'space_use_request',
    'plan_suggestion', 'follow_up_case', 'recovery_case', 'compensation',
    'ownership_transfer', 'closed_unit_round', 'unit_entry_report'));
ALTER TABLE "staff_inbox_overdue" DROP CONSTRAINT "staff_inbox_overdue_type";
ALTER TABLE "staff_inbox_overdue" ADD CONSTRAINT "staff_inbox_overdue_type"
  CHECK ("type" IN ('registration', 'identity_change', 'worker_engagement', 'vehicle',
    'booking', 'unit_permit', 'work_permit', 'field_exception', 'plan_request',
    'invoice_dispute', 'decision_appeal', 'management_request', 'purchase_request', 'space_use_request',
    'plan_suggestion', 'follow_up_case', 'recovery_case', 'compensation',
    'ownership_transfer', 'closed_unit_round', 'unit_entry_report'));
