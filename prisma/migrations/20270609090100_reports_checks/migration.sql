-- ============================================================================
-- The CHECKs ADR 0086 widened, restored after the later-dated migrations
-- that recreate them (ADR 0089's 20270601090000 the approval types', ADR
-- 0088's 20270608090100 the files' content type): each with every value, so
-- a fresh database and an existing one both end with all of them. The
-- files' two CHECKs are ADR 0086's own, here rather than in 20270504090100:
-- they name purposes added after that date (a run's file and the export
-- with their types and limits, beside every other purpose). The content
-- type's last: its spec reads it to the end. The compound's logo (ADR
-- 0075) takes a PNG or a JPEG only, as its purpose does. Its only rows:
-- the capital plan's setting, one per compound.
-- ============================================================================

ALTER TABLE "governance_approval_requests" DROP CONSTRAINT "governance_approval_requests_type";
ALTER TABLE "governance_approval_requests" ADD CONSTRAINT "governance_approval_requests_type"
  CHECK ("type" IN ('annual_budget', 'budget_increase', 'major_contract', 'exceptional_fee',
                    'waiver_above_limit', 'payment_plan_above_limit', 'legal_escalation',
                    'compensation_above_limit', 'manager_handover_override', 'budget_transfer',
                    'capital_plan'));
ALTER TABLE "governance_approval_requests" DROP CONSTRAINT "governance_approval_requests_subject";
ALTER TABLE "governance_approval_requests" ADD CONSTRAINT "governance_approval_requests_subject"
  CHECK (("subject_id" IS NOT NULL) = ("type" IN ('annual_budget', 'budget_increase', 'manager_handover_override',
                                                'budget_transfer', 'capital_plan')));
ALTER TABLE "governance_approval_settings" DROP CONSTRAINT "governance_approval_settings_type";
ALTER TABLE "governance_approval_settings" ADD CONSTRAINT "governance_approval_settings_type"
  CHECK ("type" IN ('annual_budget', 'budget_increase', 'major_contract', 'exceptional_fee',
                    'waiver_above_limit', 'payment_plan_above_limit', 'legal_escalation',
                    'compensation_above_limit', 'manager_handover_override', 'budget_transfer',
                    'capital_plan', 'board_appeal', 'objection'));
-- Every compound gets the capital plan's setting (ADR 0086), now that the
-- settings' CHECK knows the type for good. FORCE RLS applies to the migrator
-- too: one compound at a time.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    INSERT INTO "governance_approval_settings" ("tenant_id", "type", "deadline_days")
      VALUES (t."id", 'capital_plan', 30)
      ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

ALTER TABLE "files" DROP CONSTRAINT "files_size_for_purpose";
ALTER TABLE "files" ADD CONSTRAINT "files_size_for_purpose"
  CHECK ("size_bytes" > 0 AND "size_bytes" <= CASE "purpose"
           WHEN 'worker_photo' THEN 5242880
           WHEN 'resident_photo' THEN 5242880
           WHEN 'ticket_photo' THEN 5242880
           WHEN 'parcel_photo' THEN 5242880
           WHEN 'neighbour_post_photo' THEN 5242880
           WHEN 'gate_request_photo' THEN 5242880
           WHEN 'parking_photo' THEN 5242880
           WHEN 'vehicle_fine_photo' THEN 5242880
           WHEN 'gate_service_photo' THEN 5242880
           WHEN 'dispute_photo' THEN 5242880
           WHEN 'contractor_photo' THEN 5242880
           WHEN 'permit_photo' THEN 5242880
           WHEN 'guard_task_photo' THEN 5242880
           WHEN 'found_item_photo' THEN 5242880
           WHEN 'patrol_photo' THEN 5242880
           WHEN 'incident_photo' THEN 5242880
           WHEN 'blocklist_photo' THEN 5242880
           WHEN 'violation_photo' THEN 5242880
           WHEN 'violation_appeal_photo' THEN 5242880
           WHEN 'child_photo' THEN 5242880
           WHEN 'child_escort_photo' THEN 5242880
           WHEN 'visitor_photo' THEN 5242880
           WHEN 'checklist_photo' THEN 5242880
           WHEN 'gate_face_probe' THEN 5242880
           WHEN 'gate_id_scan' THEN 5242880
           WHEN 'market_listing_photo' THEN 5242880
           WHEN 'damage_appeal_photo' THEN 5242880
           WHEN 'patrol_note_audio' THEN 20971520
           WHEN 'patrol_note_video' THEN 104857600
           WHEN 'incident_audio' THEN 20971520
           WHEN 'incident_video' THEN 104857600
           WHEN 'incident_signature' THEN 262144
           WHEN 'data_import' THEN 1048576
           WHEN 'data_export' THEN 536870912
           WHEN 'report_file' THEN 20971520
           WHEN 'compound_export' THEN 536870912
           ELSE 10485760 END);
ALTER TABLE "files" DROP CONSTRAINT "files_content_type_for_purpose";
ALTER TABLE "files" ADD CONSTRAINT "files_content_type_for_purpose"
  CHECK (("content_type" IN ('image/jpeg', 'image/png', 'image/webp') AND "purpose" NOT IN ('data_export', 'patrol_note_audio', 'patrol_note_video', 'incident_audio', 'incident_video', 'incident_signature', 'compound_document', 'data_import', 'report_file', 'compound_export', 'compound_logo'))
      OR ("content_type" = 'image/png' AND "purpose" = 'incident_signature')
      OR ("content_type" IN ('image/jpeg', 'image/png') AND "purpose" = 'compound_logo')
      OR ("content_type" = 'application/pdf' AND "purpose" IN ('document', 'request_attachment', 'community_attachment', 'complaint_evidence', 'vehicle_licence', 'approval_attachment', 'board_appeal_attachment', 'expense_invoice', 'decision_appeal_attachment', 'registration_document', 'kinship_proof', 'unit_document', 'compound_document', 'contract', 'asset_document', 'vendor_document', 'permit_drawing', 'compliance_evidence', 'tender_document', 'tender_bid', 'report_file'))
      OR ("content_type" = 'application/zip' AND "purpose" IN ('data_export', 'compound_export'))
      OR ("content_type" = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' AND "purpose" = 'report_file')
      OR ("content_type" = 'audio/mp4' AND "purpose" IN ('patrol_note_audio', 'incident_audio'))
      OR ("content_type" IN ('video/mp4', 'video/quicktime') AND "purpose" IN ('patrol_note_video', 'incident_video'))
      OR ("content_type" = 'text/csv' AND "purpose" IN ('data_import', 'report_file')));
