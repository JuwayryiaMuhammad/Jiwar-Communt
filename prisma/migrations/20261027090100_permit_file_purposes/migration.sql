-- ============================================================================
-- Permits (ADR 0049): what the new file purposes take.
--
-- `contractor_photo` and `permit_photo`: an image, 5 MB at most. An image is
-- already allowed for every purpose but `data_export`; both CHECKs are still
-- recreated here, whole, so that this file states every purpose at once (a
-- branch merged after this one recreates both again with its own).
-- ============================================================================

ALTER TABLE "files" DROP CONSTRAINT "files_content_type_for_purpose";
ALTER TABLE "files" ADD CONSTRAINT "files_content_type_for_purpose"
  CHECK (("content_type" IN ('image/jpeg', 'image/png', 'image/webp') AND "purpose" <> 'data_export')
      OR ("content_type" = 'application/pdf' AND "purpose" IN ('document', 'request_attachment', 'community_attachment', 'complaint_evidence', 'vehicle_licence'))
      OR ("content_type" = 'application/zip' AND "purpose" = 'data_export'));
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
           WHEN 'data_export' THEN 536870912
           ELSE 10485760 END);
