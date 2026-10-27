-- ============================================================================
-- Assets and inspections (ADR 0064): what the three new purposes take.
-- An asset document is an image or a PDF (10 MB, the ELSE); a checklist
-- photo an image (5 MB); an imported sheet CSV only (1 MB) and never an
-- image. Both CHECKs are recreated with every purpose, as FILE_PURPOSES in
-- src/core/files/purposes.ts has them (a unit test keeps them in step).
-- No row changes: no file has these purposes yet.
-- ============================================================================

ALTER TABLE "files" DROP CONSTRAINT "files_content_type_for_purpose";
ALTER TABLE "files" ADD CONSTRAINT "files_content_type_for_purpose"
  CHECK (("content_type" IN ('image/jpeg', 'image/png', 'image/webp') AND "purpose" NOT IN ('data_export', 'patrol_note_audio', 'patrol_note_video', 'incident_audio', 'incident_video', 'incident_signature', 'compound_document', 'data_import'))
      OR ("content_type" = 'image/png' AND "purpose" = 'incident_signature')
      OR ("content_type" = 'application/pdf' AND "purpose" IN ('document', 'request_attachment', 'community_attachment', 'complaint_evidence', 'vehicle_licence', 'approval_attachment', 'board_appeal_attachment', 'expense_invoice', 'decision_appeal_attachment', 'registration_document', 'kinship_proof', 'unit_document', 'compound_document', 'contract', 'asset_document'))
      OR ("content_type" = 'application/zip' AND "purpose" = 'data_export')
      OR ("content_type" = 'audio/mp4' AND "purpose" IN ('patrol_note_audio', 'incident_audio'))
      OR ("content_type" IN ('video/mp4', 'video/quicktime') AND "purpose" IN ('patrol_note_video', 'incident_video'))
      OR ("content_type" = 'text/csv' AND "purpose" = 'data_import'));
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
           WHEN 'patrol_note_audio' THEN 20971520
           WHEN 'patrol_note_video' THEN 104857600
           WHEN 'incident_audio' THEN 20971520
           WHEN 'incident_video' THEN 104857600
           WHEN 'incident_signature' THEN 262144
           WHEN 'data_import' THEN 1048576
           WHEN 'data_export' THEN 536870912
           ELSE 10485760 END);
