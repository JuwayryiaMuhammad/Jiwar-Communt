-- ============================================================================
-- The CHECKs ADR 0090 widened, stated last with every value before them, so
-- a fresh database and an existing one both end with all of them: the staff
-- inbox's types (a dangling account, an access review, a reinforcement
-- suggestion, after ADR 0085's), and the files' content type with the
-- staff certificate's purpose (20270614090000) among the PDFs — a photo
-- takes it already, as every purpose not named there. The size CHECK is
-- ADR 0086's as it stands: the certificate's 10 MB is its default. The
-- content type's last: its spec reads it to the end. No row changes.
-- ============================================================================

ALTER TABLE "staff_inbox_due_hours" DROP CONSTRAINT "staff_inbox_due_hours_type";
ALTER TABLE "staff_inbox_due_hours" ADD CONSTRAINT "staff_inbox_due_hours_type"
  CHECK ("type" IN ('registration', 'identity_change', 'worker_engagement', 'vehicle',
    'booking', 'unit_permit', 'work_permit', 'field_exception', 'plan_request',
    'invoice_dispute', 'decision_appeal', 'management_request', 'purchase_request', 'space_use_request',
    'plan_suggestion', 'follow_up_case', 'recovery_case', 'compensation',
    'ownership_transfer', 'closed_unit_round', 'unit_entry_report',
    'vendor_invoice', 'contract_disbursement', 'tender_opening', 'cash_custody', 'custody_variance',
    'dangling_account', 'access_review', 'reinforcement_suggestion'));
ALTER TABLE "staff_inbox_overdue" DROP CONSTRAINT "staff_inbox_overdue_type";
ALTER TABLE "staff_inbox_overdue" ADD CONSTRAINT "staff_inbox_overdue_type"
  CHECK ("type" IN ('registration', 'identity_change', 'worker_engagement', 'vehicle',
    'booking', 'unit_permit', 'work_permit', 'field_exception', 'plan_request',
    'invoice_dispute', 'decision_appeal', 'management_request', 'purchase_request', 'space_use_request',
    'plan_suggestion', 'follow_up_case', 'recovery_case', 'compensation',
    'ownership_transfer', 'closed_unit_round', 'unit_entry_report',
    'vendor_invoice', 'contract_disbursement', 'tender_opening', 'cash_custody', 'custody_variance',
    'dangling_account', 'access_review', 'reinforcement_suggestion'));

ALTER TABLE "files" DROP CONSTRAINT "files_content_type_for_purpose";
ALTER TABLE "files" ADD CONSTRAINT "files_content_type_for_purpose"
  CHECK (("content_type" IN ('image/jpeg', 'image/png', 'image/webp') AND "purpose" NOT IN ('data_export', 'patrol_note_audio', 'patrol_note_video', 'incident_audio', 'incident_video', 'incident_signature', 'compound_document', 'data_import', 'report_file', 'compound_export', 'compound_logo'))
      OR ("content_type" = 'image/png' AND "purpose" = 'incident_signature')
      OR ("content_type" IN ('image/jpeg', 'image/png') AND "purpose" = 'compound_logo')
      OR ("content_type" = 'application/pdf' AND "purpose" IN ('document', 'request_attachment', 'community_attachment', 'complaint_evidence', 'vehicle_licence', 'approval_attachment', 'board_appeal_attachment', 'expense_invoice', 'decision_appeal_attachment', 'registration_document', 'kinship_proof', 'unit_document', 'compound_document', 'contract', 'asset_document', 'vendor_document', 'permit_drawing', 'compliance_evidence', 'tender_document', 'tender_bid', 'report_file', 'staff_certificate'))
      OR ("content_type" = 'application/zip' AND "purpose" IN ('data_export', 'compound_export'))
      OR ("content_type" = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' AND "purpose" = 'report_file')
      OR ("content_type" = 'audio/mp4' AND "purpose" IN ('patrol_note_audio', 'incident_audio'))
      OR ("content_type" IN ('video/mp4', 'video/quicktime') AND "purpose" IN ('patrol_note_video', 'incident_video'))
      OR ("content_type" = 'text/csv' AND "purpose" IN ('data_import', 'report_file')));
