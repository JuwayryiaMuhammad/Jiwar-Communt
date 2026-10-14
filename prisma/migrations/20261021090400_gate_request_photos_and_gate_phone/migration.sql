-- ============================================================================
-- Gate card, visitors (ADR 0043).
--
-- A gate request may carry the photo the guard took of the visitor
-- (`gate_request_photo`: an image, 5 MB at most). The household that is
-- asked and the guards see it through short-lived presigned URLs; it is
-- deleted 7 days after the request is decided (the pointer first, then the
-- file, by the `gate.request_photos` sweep).
--
-- A gate may have a phone the household can call from the request
-- (E.164, set by the manager); residents see it with the gate's status.
-- ============================================================================

ALTER TABLE "gate_approval_requests" ADD COLUMN "photo_file_id" UUID;
ALTER TABLE "gate_approval_requests"
  ADD CONSTRAINT "gate_approval_requests_tenant_id_photo_file_fkey"
  FOREIGN KEY ("tenant_id", "photo_file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX "gate_approval_requests_photo_due_idx"
  ON "gate_approval_requests"("tenant_id", "decided_at")
  WHERE "photo_file_id" IS NOT NULL;

ALTER TABLE "files" DROP CONSTRAINT "files_content_type_for_purpose";
ALTER TABLE "files" ADD CONSTRAINT "files_content_type_for_purpose"
  CHECK (("content_type" IN ('image/jpeg', 'image/png', 'image/webp') AND "purpose" <> 'data_export')
      OR ("content_type" = 'application/pdf' AND "purpose" IN ('document', 'request_attachment', 'community_attachment', 'complaint_evidence'))
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
           WHEN 'data_export' THEN 536870912
           ELSE 10485760 END);

ALTER TABLE "gates" ADD COLUMN "phone" TEXT;
ALTER TABLE "gates" ADD CONSTRAINT "gates_phone_e164"
  CHECK ("phone" IS NULL OR "phone" ~ '^\+[1-9][0-9]{6,14}$');
