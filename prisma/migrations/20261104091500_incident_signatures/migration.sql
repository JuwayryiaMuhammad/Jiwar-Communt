-- ============================================================================
-- A drawn signature on an incident report (ADR 0056).
--
-- - `incident_signature`: a PNG of the signature, 256 KB at most. Both file
--   CHECKs are recreated with every purpose (R7b's three of
--   20261102090100 included).
-- - `incident_signatures`: who signed which report, as `author` (who
--   reported it) or `reviewer` (a keeper who did not), and the SHA-256 of
--   the report's canonical content for that role when they signed
--   (`canonical_version` says which canonical form). The author's content
--   is the report: its fields and its photos', recordings' and evidence's
--   ids; the reviewer's is that and its status, outcome and closing note.
--   A signature never changes: whether it is superseded — the content of
--   its role differs now — is computed when read. One per role and
--   content. At its signer's erasure, the image goes, once (file_id NULL,
--   image_cleared_at set); the hash and the time stay.
-- ============================================================================

ALTER TABLE "files" DROP CONSTRAINT "files_content_type_for_purpose";
ALTER TABLE "files" ADD CONSTRAINT "files_content_type_for_purpose"
  CHECK (("content_type" IN ('image/jpeg', 'image/png', 'image/webp') AND "purpose" NOT IN ('data_export', 'patrol_note_audio', 'patrol_note_video', 'incident_audio', 'incident_video', 'incident_signature'))
      OR ("content_type" = 'image/png' AND "purpose" = 'incident_signature')
      OR ("content_type" = 'application/pdf' AND "purpose" IN ('document', 'request_attachment', 'community_attachment', 'complaint_evidence', 'vehicle_licence', 'approval_attachment', 'board_appeal_attachment', 'expense_invoice'))
      OR ("content_type" = 'application/zip' AND "purpose" = 'data_export')
      OR ("content_type" = 'audio/mp4' AND "purpose" IN ('patrol_note_audio', 'incident_audio'))
      OR ("content_type" IN ('video/mp4', 'video/quicktime') AND "purpose" IN ('patrol_note_video', 'incident_video')));
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
           WHEN 'patrol_note_audio' THEN 20971520
           WHEN 'patrol_note_video' THEN 104857600
           WHEN 'incident_audio' THEN 20971520
           WHEN 'incident_video' THEN 104857600
           WHEN 'incident_signature' THEN 262144
           WHEN 'data_export' THEN 536870912
           ELSE 10485760 END);

CREATE TABLE "incident_signatures" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "signer_account_id" UUID NOT NULL,
    "file_id" UUID,
    "content_sha256" CHAR(64) NOT NULL,
    "canonical_version" SMALLINT NOT NULL,
    "signed_at" TIMESTAMPTZ(3) NOT NULL,
    "image_cleared_at" TIMESTAMPTZ(3),
    CONSTRAINT "incident_signatures_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "incident_signatures_tenant_id_id_key" ON "incident_signatures"("tenant_id", "id");
-- One per role and content.
CREATE UNIQUE INDEX "incident_signatures_once_key"
  ON "incident_signatures"("tenant_id", "incident_id", "role", "content_sha256");
CREATE UNIQUE INDEX "incident_signatures_file_key"
  ON "incident_signatures"("tenant_id", "file_id") WHERE "file_id" IS NOT NULL;
CREATE INDEX "incident_signatures_incident_idx"
  ON "incident_signatures"("tenant_id", "incident_id", "signed_at");
CREATE INDEX "incident_signatures_signer_idx"
  ON "incident_signatures"("tenant_id", "signer_account_id");
ALTER TABLE "incident_signatures"
  ADD CONSTRAINT "incident_signatures_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "incident_signatures_incident_fkey"
    FOREIGN KEY ("tenant_id", "incident_id") REFERENCES "incidents"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "incident_signatures_signer_fkey"
    FOREIGN KEY ("tenant_id", "signer_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "incident_signatures_file_fkey"
    FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "incident_signatures_role" CHECK ("role" IN ('author', 'reviewer')),
  ADD CONSTRAINT "incident_signatures_sha256" CHECK ("content_sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "incident_signatures_version" CHECK ("canonical_version" >= 1),
  ADD CONSTRAINT "incident_signatures_image_shape"
    CHECK (("file_id" IS NULL) = ("image_cleared_at" IS NOT NULL));

-- Nothing of a signature changes but its image going, once.
CREATE FUNCTION incident_signature_is_kept() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."incident_id" = OLD."incident_id"
     AND NEW."role" = OLD."role"
     AND NEW."signer_account_id" = OLD."signer_account_id"
     AND NEW."content_sha256" = OLD."content_sha256"
     AND NEW."canonical_version" = OLD."canonical_version"
     AND NEW."signed_at" = OLD."signed_at"
     AND ((NEW."file_id" IS NOT DISTINCT FROM OLD."file_id"
           AND NEW."image_cleared_at" IS NOT DISTINCT FROM OLD."image_cleared_at")
          OR (OLD."image_cleared_at" IS NULL AND NEW."file_id" IS NULL)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'incident_signatures: a signature never changes, but its image goes once; never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER incident_signatures_kept
  BEFORE UPDATE OR DELETE ON "incident_signatures"
  FOR EACH ROW EXECUTE FUNCTION incident_signature_is_kept();
CREATE TRIGGER incident_signatures_kept_truncate
  BEFORE TRUNCATE ON "incident_signatures"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "incident_signatures" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "incident_signatures" TO jiwar_app;
ALTER TABLE "incident_signatures" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "incident_signatures" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "incident_signatures"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
