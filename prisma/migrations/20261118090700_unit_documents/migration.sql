-- ============================================================================
-- A unit's document vault and its warranties (ADR 0062)
-- ============================================================================
--
-- A document belongs to an occupancy (`owner_occupancy_id`: a resident's
-- upload, a registrant's proof moved here at approval) or to the unit (no
-- owner: the management's upload). Who sees it is its visibility:
-- `private` its occupancy only, `owners` the unit's active owners,
-- `occupants` every active occupancy (and a `documents` delegate). A
-- document of an occupancy that ended is that occupancy's alone, and goes
-- 90 days after it was handed over (or ended). A warranty has an end date;
-- the residents are told 30 days before it, once. A document is deleted
-- once; its file then goes with the files sweep, and the row with the file.
-- Nothing else about it changes.

ALTER TABLE "files" DROP CONSTRAINT "files_content_type_for_purpose";
ALTER TABLE "files" ADD CONSTRAINT "files_content_type_for_purpose"
  CHECK (("content_type" IN ('image/jpeg', 'image/png', 'image/webp') AND "purpose" NOT IN ('data_export', 'patrol_note_audio', 'patrol_note_video', 'incident_audio', 'incident_video', 'incident_signature'))
      OR ("content_type" = 'image/png' AND "purpose" = 'incident_signature')
      OR ("content_type" = 'application/pdf' AND "purpose" IN ('document', 'request_attachment', 'community_attachment', 'complaint_evidence', 'vehicle_licence', 'approval_attachment', 'board_appeal_attachment', 'expense_invoice', 'decision_appeal_attachment', 'registration_document', 'kinship_proof', 'unit_document'))
      OR ("content_type" = 'application/zip' AND "purpose" = 'data_export')
      OR ("content_type" = 'audio/mp4' AND "purpose" IN ('patrol_note_audio', 'incident_audio'))
      OR ("content_type" IN ('video/mp4', 'video/quicktime') AND "purpose" IN ('patrol_note_video', 'incident_video')));

CREATE TABLE "unit_documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "owner_occupancy_id" UUID,
    "uploaded_by" UUID,
    "visibility" TEXT NOT NULL,
    "expires_on" DATE,
    "expiry_notified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    CONSTRAINT "unit_documents_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "unit_documents_tenant_id_id_key" ON "unit_documents"("tenant_id", "id");
CREATE UNIQUE INDEX "unit_documents_file_id_key" ON "unit_documents"("file_id");
CREATE INDEX "unit_documents_unit_idx"
  ON "unit_documents"("tenant_id", "unit_id", "created_at" DESC) WHERE "deleted_at" IS NULL;
CREATE INDEX "unit_documents_warranty_idx"
  ON "unit_documents"("tenant_id", "expires_on")
  WHERE "expires_on" IS NOT NULL AND "expiry_notified_at" IS NULL AND "deleted_at" IS NULL;
ALTER TABLE "unit_documents"
  ADD CONSTRAINT "unit_documents_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_documents_unit_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- The row goes with its file, which the files sweep deletes only after
  -- the document was marked deleted (the trigger refuses any other delete).
  ADD CONSTRAINT "unit_documents_file_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_documents_occupancy_fkey"
  FOREIGN KEY ("tenant_id", "owner_occupancy_id") REFERENCES "unit_occupancies"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_documents_uploaded_by_fkey"
  FOREIGN KEY ("tenant_id", "uploaded_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "unit_documents" ADD CONSTRAINT "unit_documents_kind"
  CHECK ("kind" IN ('warranty', 'manual', 'handover_report', 'utility', 'insurance',
                    'capacity_proof', 'inspection_report', 'other'));
ALTER TABLE "unit_documents" ADD CONSTRAINT "unit_documents_title"
  CHECK (char_length("title") BETWEEN 1 AND 120);
-- A private document is an occupancy's; the management's are shared.
ALTER TABLE "unit_documents" ADD CONSTRAINT "unit_documents_visibility"
  CHECK ("visibility" IN ('private', 'owners', 'occupants')
     AND ("visibility" <> 'private' OR "owner_occupancy_id" IS NOT NULL));
-- A warranty has an end date; nothing else does. Told once, after created.
ALTER TABLE "unit_documents" ADD CONSTRAINT "unit_documents_expiry_shape"
  CHECK (("kind" = 'warranty') = ("expires_on" IS NOT NULL)
     AND ("expiry_notified_at" IS NULL OR "expires_on" IS NOT NULL));
ALTER TABLE "unit_documents" ADD CONSTRAINT "unit_documents_times"
  CHECK (("deleted_at" IS NULL OR "deleted_at" >= "created_at")
     AND ("expiry_notified_at" IS NULL OR "expiry_notified_at" >= "created_at"));

CREATE FUNCTION unit_document_changes_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD."deleted_at" IS NOT NULL THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."unit_id" = OLD."unit_id"
     AND NEW."file_id" = OLD."file_id"
     AND NEW."kind" = OLD."kind"
     AND NEW."title" = OLD."title"
     AND NEW."owner_occupancy_id" IS NOT DISTINCT FROM OLD."owner_occupancy_id"
     AND NEW."uploaded_by" IS NOT DISTINCT FROM OLD."uploaded_by"
     AND NEW."visibility" = OLD."visibility"
     AND NEW."expires_on" IS NOT DISTINCT FROM OLD."expires_on"
     AND NEW."created_at" = OLD."created_at"
     AND (OLD."deleted_at" IS NULL OR NEW."deleted_at" = OLD."deleted_at")
     AND (OLD."expiry_notified_at" IS NULL
          OR NEW."expiry_notified_at" = OLD."expiry_notified_at") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'unit_documents: only deleted_at and expiry_notified_at are set, once each; a row goes only once deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER unit_documents_changes_once
  BEFORE UPDATE OR DELETE ON "unit_documents"
  FOR EACH ROW EXECUTE FUNCTION unit_document_changes_once();
CREATE TRIGGER unit_documents_no_truncate
  BEFORE TRUNCATE ON "unit_documents"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "unit_documents" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "unit_documents" TO jiwar_app;
ALTER TABLE "unit_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "unit_documents" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "unit_documents"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
