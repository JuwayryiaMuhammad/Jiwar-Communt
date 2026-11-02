-- ============================================================================
-- Maintenance analytics (ADR 0081) in the staff inbox (ADR 0073): an open plan
-- suggestion is the type `plan_suggestion`, for whoever keeps the plans. Both
-- inbox CHECKs recreated whole once more, with every type before it (the
-- purchase requests of 20270302090400 and the common-area uses of
-- 20270420090300). Dated after the latter, so it is applied last whichever
-- order a database met them in. No row changes.
-- ============================================================================

ALTER TABLE "staff_inbox_due_hours" DROP CONSTRAINT "staff_inbox_due_hours_type";
ALTER TABLE "staff_inbox_due_hours" ADD CONSTRAINT "staff_inbox_due_hours_type"
  CHECK ("type" IN ('registration', 'identity_change', 'worker_engagement', 'vehicle',
    'booking', 'unit_permit', 'work_permit', 'field_exception', 'plan_request',
    'invoice_dispute', 'decision_appeal', 'management_request', 'purchase_request', 'space_use_request',
    'plan_suggestion'));
ALTER TABLE "staff_inbox_overdue" DROP CONSTRAINT "staff_inbox_overdue_type";
ALTER TABLE "staff_inbox_overdue" ADD CONSTRAINT "staff_inbox_overdue_type"
  CHECK ("type" IN ('registration', 'identity_change', 'worker_engagement', 'vehicle',
    'booking', 'unit_permit', 'work_permit', 'field_exception', 'plan_request',
    'invoice_dispute', 'decision_appeal', 'management_request', 'purchase_request', 'space_use_request',
    'plan_suggestion'));
