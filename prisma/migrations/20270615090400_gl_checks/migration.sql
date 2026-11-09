-- ============================================================================
-- The CHECKs ADR 0092 widened, stated last with every value before them, so
-- a fresh database and an existing one both end with all of them: the
-- finance counters with the manual journal entry's (`journal_entry`, JE-),
-- and the staff inbox's types with a manual entry waiting for its second
-- person (`gl_manual_entry`), after ADR 0090's. No row changes.
-- ============================================================================

ALTER TABLE "finance_counters" DROP CONSTRAINT "finance_counters_kind";
ALTER TABLE "finance_counters" ADD CONSTRAINT "finance_counters_kind"
  CHECK ("kind" IN ('invoice', 'credit_note', 'receipt', 'instalment_plan', 'refund', 'expense',
                    'clearance', 'deposit', 'vendor_invoice', 'disbursement', 'payout', 'handin',
                    'journal_entry'));

ALTER TABLE "staff_inbox_due_hours" DROP CONSTRAINT "staff_inbox_due_hours_type";
ALTER TABLE "staff_inbox_due_hours" ADD CONSTRAINT "staff_inbox_due_hours_type"
  CHECK ("type" IN ('registration', 'identity_change', 'worker_engagement', 'vehicle',
    'booking', 'unit_permit', 'work_permit', 'field_exception', 'plan_request',
    'invoice_dispute', 'decision_appeal', 'management_request', 'purchase_request', 'space_use_request',
    'plan_suggestion', 'follow_up_case', 'recovery_case', 'compensation',
    'ownership_transfer', 'closed_unit_round', 'unit_entry_report',
    'vendor_invoice', 'contract_disbursement', 'tender_opening', 'cash_custody', 'custody_variance',
    'dangling_account', 'access_review', 'reinforcement_suggestion', 'gl_manual_entry'));
ALTER TABLE "staff_inbox_overdue" DROP CONSTRAINT "staff_inbox_overdue_type";
ALTER TABLE "staff_inbox_overdue" ADD CONSTRAINT "staff_inbox_overdue_type"
  CHECK ("type" IN ('registration', 'identity_change', 'worker_engagement', 'vehicle',
    'booking', 'unit_permit', 'work_permit', 'field_exception', 'plan_request',
    'invoice_dispute', 'decision_appeal', 'management_request', 'purchase_request', 'space_use_request',
    'plan_suggestion', 'follow_up_case', 'recovery_case', 'compensation',
    'ownership_transfer', 'closed_unit_round', 'unit_entry_report',
    'vendor_invoice', 'contract_disbursement', 'tender_opening', 'cash_custody', 'custody_variance',
    'dangling_account', 'access_review', 'reinforcement_suggestion', 'gl_manual_entry'));
