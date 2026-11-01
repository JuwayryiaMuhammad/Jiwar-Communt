-- ============================================================================
-- The compound's logo (ADR 0075) is a PNG or a JPEG, which a PDF can draw.
-- ADR 0087's recreation (20270518090100) left it under the image default,
-- so it took a WebP too: the content type CHECK is recreated whole with
-- every purpose, as FILE_PURPOSES in src/core/files/purposes.ts has them (a
-- unit test keeps them in step). Dated after it, it is applied last. No row
-- changes: the purpose is new in this release, and an upload takes only
-- the types FILE_PURPOSES lists.
-- ============================================================================

ALTER TABLE "files" DROP CONSTRAINT "files_content_type_for_purpose";
ALTER TABLE "files" ADD CONSTRAINT "files_content_type_for_purpose"
  CHECK (("content_type" IN ('image/jpeg', 'image/png', 'image/webp') AND "purpose" NOT IN ('data_export', 'patrol_note_audio', 'patrol_note_video', 'incident_audio', 'incident_video', 'incident_signature', 'compound_document', 'data_import', 'compound_logo'))
      OR ("content_type" = 'image/png' AND "purpose" = 'incident_signature')
      OR ("content_type" IN ('image/jpeg', 'image/png') AND "purpose" = 'compound_logo')
      OR ("content_type" = 'application/pdf' AND "purpose" IN ('document', 'request_attachment', 'community_attachment', 'complaint_evidence', 'vehicle_licence', 'approval_attachment', 'board_appeal_attachment', 'expense_invoice', 'decision_appeal_attachment', 'registration_document', 'kinship_proof', 'unit_document', 'compound_document', 'contract', 'asset_document', 'vendor_document', 'permit_drawing', 'compliance_evidence'))
      OR ("content_type" = 'application/zip' AND "purpose" = 'data_export')
      OR ("content_type" = 'audio/mp4' AND "purpose" IN ('patrol_note_audio', 'incident_audio'))
      OR ("content_type" IN ('video/mp4', 'video/quicktime') AND "purpose" IN ('patrol_note_video', 'incident_video'))
      OR ("content_type" = 'text/csv' AND "purpose" = 'data_import'));
