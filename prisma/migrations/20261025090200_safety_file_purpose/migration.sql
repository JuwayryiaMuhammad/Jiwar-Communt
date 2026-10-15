-- ============================================================================
-- Emergencies and gate services (ADR 0047): what the new file purpose takes.
--
-- `gate_service_photo`: an image, 5 MB at most. The content-type CHECK needs
-- no change (an image is allowed for every purpose but `data_export`).
-- ============================================================================

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
           WHEN 'data_export' THEN 536870912
           ELSE 10485760 END);
