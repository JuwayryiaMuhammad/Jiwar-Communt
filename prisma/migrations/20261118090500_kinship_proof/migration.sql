-- ============================================================================
-- Proof of kinship on a household invite (ADR 0062)
-- ============================================================================
--
-- The primary (or a household delegate) may attach up to two documents
-- proving the invitee's relation; the compound decides whether that is
-- off, optional or required (required only matters where a manager
-- approves joins). The documents serve that decision and nothing else: the
-- retention sweep stamps `released_at` the first time it finds the invite
-- settled (expired, revoked, or accepted with no approval pending), and
-- deletes the files 30 days later; each row goes with its file.

ALTER TABLE "files" DROP CONSTRAINT "files_content_type_for_purpose";
ALTER TABLE "files" ADD CONSTRAINT "files_content_type_for_purpose"
  CHECK (("content_type" IN ('image/jpeg', 'image/png', 'image/webp') AND "purpose" NOT IN ('data_export', 'patrol_note_audio', 'patrol_note_video', 'incident_audio', 'incident_video', 'incident_signature'))
      OR ("content_type" = 'image/png' AND "purpose" = 'incident_signature')
      OR ("content_type" = 'application/pdf' AND "purpose" IN ('document', 'request_attachment', 'community_attachment', 'complaint_evidence', 'vehicle_licence', 'approval_attachment', 'board_appeal_attachment', 'expense_invoice', 'decision_appeal_attachment', 'registration_document', 'kinship_proof'))
      OR ("content_type" = 'application/zip' AND "purpose" = 'data_export')
      OR ("content_type" = 'audio/mp4' AND "purpose" IN ('patrol_note_audio', 'incident_audio'))
      OR ("content_type" IN ('video/mp4', 'video/quicktime') AND "purpose" IN ('patrol_note_video', 'incident_video')));

ALTER TABLE "tenant_settings"
  ADD COLUMN "family_kinship_proof" TEXT NOT NULL DEFAULT 'optional';
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_family_kinship_proof"
  CHECK ("family_kinship_proof" IN ('off', 'optional', 'required'));

CREATE UNIQUE INDEX "household_invites_tenant_id_id_key"
  ON "household_invites"("tenant_id", "id");

CREATE TABLE "household_invite_documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "invite_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "released_at" TIMESTAMPTZ(3),
    CONSTRAINT "household_invite_documents_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "household_invite_documents_file_id_key"
  ON "household_invite_documents"("file_id");
CREATE INDEX "household_invite_documents_invite_idx"
  ON "household_invite_documents"("tenant_id", "invite_id");
ALTER TABLE "household_invite_documents"
  ADD CONSTRAINT "household_invite_documents_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "household_invite_documents_invite_fkey"
  FOREIGN KEY ("tenant_id", "invite_id") REFERENCES "household_invites"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "household_invite_documents_file_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "household_invite_documents" ADD CONSTRAINT "household_invite_documents_kind"
  CHECK ("kind" IN ('birth_certificate', 'marriage_certificate', 'family_record', 'other'));
ALTER TABLE "household_invite_documents" ADD CONSTRAINT "household_invite_documents_released_after"
  CHECK ("released_at" IS NULL OR "released_at" >= "created_at");

-- Only `released_at` changes, once; a row is deleted only with its file.
CREATE FUNCTION household_invite_document_released_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."released_at" IS NULL AND NEW."released_at" IS NOT NULL
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."invite_id" = OLD."invite_id"
     AND NEW."file_id" = OLD."file_id"
     AND NEW."kind" = OLD."kind"
     AND NEW."created_at" = OLD."created_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'household_invite_documents: only released_at is set, once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER household_invite_documents_released_once
  BEFORE UPDATE ON "household_invite_documents"
  FOR EACH ROW EXECUTE FUNCTION household_invite_document_released_once();
CREATE TRIGGER household_invite_documents_no_truncate
  BEFORE TRUNCATE ON "household_invite_documents"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "household_invite_documents" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "household_invite_documents" TO jiwar_app;
ALTER TABLE "household_invite_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "household_invite_documents" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "household_invite_documents"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
