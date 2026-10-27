-- ============================================================================
-- The compound's documents, versioned (ADR 0062)
-- ============================================================================
--
-- The bylaws, the occupants' rights in plain language, the code of conduct
-- and the moving guide. Each kind is a series of versions, numbered from 1
-- in the order published, never changed: an amendment is a new version
-- with what it changes. A bylaws version cites the board's published
-- decision that adopted it (a composite key; that it is a decision is the
-- service's check). A version may carry its signed PDF.

ALTER TABLE "files" DROP CONSTRAINT "files_content_type_for_purpose";
ALTER TABLE "files" ADD CONSTRAINT "files_content_type_for_purpose"
  CHECK (("content_type" IN ('image/jpeg', 'image/png', 'image/webp') AND "purpose" NOT IN ('data_export', 'patrol_note_audio', 'patrol_note_video', 'incident_audio', 'incident_video', 'incident_signature', 'compound_document'))
      OR ("content_type" = 'image/png' AND "purpose" = 'incident_signature')
      OR ("content_type" = 'application/pdf' AND "purpose" IN ('document', 'request_attachment', 'community_attachment', 'complaint_evidence', 'vehicle_licence', 'approval_attachment', 'board_appeal_attachment', 'expense_invoice', 'decision_appeal_attachment', 'registration_document', 'kinship_proof', 'unit_document', 'compound_document'))
      OR ("content_type" = 'application/zip' AND "purpose" = 'data_export')
      OR ("content_type" = 'audio/mp4' AND "purpose" IN ('patrol_note_audio', 'incident_audio'))
      OR ("content_type" IN ('video/mp4', 'video/quicktime') AND "purpose" IN ('patrol_note_video', 'incident_video')));

CREATE TABLE "compound_document_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "version_no" INTEGER NOT NULL,
    "title_en" TEXT NOT NULL,
    "title_ar" TEXT NOT NULL,
    "body_en" TEXT NOT NULL,
    "body_ar" TEXT NOT NULL,
    "changes_en" TEXT,
    "changes_ar" TEXT,
    "effective_on" DATE NOT NULL,
    "file_id" UUID,
    "board_publication_id" UUID,
    "published_by" UUID NOT NULL,
    "published_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "compound_document_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "compound_document_versions_number_key"
  ON "compound_document_versions"("tenant_id", "kind", "version_no");
CREATE UNIQUE INDEX "compound_document_versions_file_id_key"
  ON "compound_document_versions"("file_id") WHERE "file_id" IS NOT NULL;
ALTER TABLE "compound_document_versions"
  ADD CONSTRAINT "compound_document_versions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "compound_document_versions_file_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "compound_document_versions_publication_fkey"
  FOREIGN KEY ("tenant_id", "board_publication_id") REFERENCES "board_publications"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "compound_document_versions_published_by_fkey"
  FOREIGN KEY ("tenant_id", "published_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "compound_document_versions" ADD CONSTRAINT "compound_document_versions_kind"
  CHECK ("kind" IN ('bylaws', 'occupant_rights', 'conduct_guide', 'moving_guide'));
ALTER TABLE "compound_document_versions" ADD CONSTRAINT "compound_document_versions_number"
  CHECK ("version_no" >= 1);
ALTER TABLE "compound_document_versions" ADD CONSTRAINT "compound_document_versions_texts"
  CHECK (char_length("title_en") BETWEEN 1 AND 200 AND char_length("title_ar") BETWEEN 1 AND 200
     AND char_length("body_en") BETWEEN 1 AND 50000 AND char_length("body_ar") BETWEEN 1 AND 50000);
-- An amendment says what it changes, in both languages; the first does not.
ALTER TABLE "compound_document_versions" ADD CONSTRAINT "compound_document_versions_changes"
  CHECK (("version_no" = 1) = ("changes_en" IS NULL)
     AND ("changes_en" IS NULL) = ("changes_ar" IS NULL)
     AND ("changes_en" IS NULL OR char_length("changes_en") BETWEEN 1 AND 5000)
     AND ("changes_ar" IS NULL OR char_length("changes_ar") BETWEEN 1 AND 5000));
-- The bylaws, and only they, cite the board's decision.
ALTER TABLE "compound_document_versions" ADD CONSTRAINT "compound_document_versions_board"
  CHECK (("kind" = 'bylaws') = ("board_publication_id" IS NOT NULL));

CREATE TRIGGER compound_document_versions_immutable
  BEFORE UPDATE OR DELETE ON "compound_document_versions"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER compound_document_versions_no_truncate
  BEFORE TRUNCATE ON "compound_document_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "compound_document_versions" FROM jiwar_app;
GRANT SELECT, INSERT ON "compound_document_versions" TO jiwar_app;
ALTER TABLE "compound_document_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "compound_document_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "compound_document_versions"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
