-- ============================================================================
-- Invoice disputes (ADR 0048): what the new file purpose takes.
--
-- `dispute_photo`: an image, 5 MB at most.
--
-- G6a (ADR 0047) merged first with its own purpose, `gate_service_photo`
-- (20261025090200): both CHECKs are recreated here with both purposes.
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
           WHEN 'data_export' THEN 536870912
           ELSE 10485760 END);
