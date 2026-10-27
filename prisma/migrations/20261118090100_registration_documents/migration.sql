-- ============================================================================
-- Registration documents, the status link and corrections (ADR 0062)
-- ============================================================================
--
-- A registrant (no account) proves their capacity with up to three
-- documents, follows their request through a link emailed to them, and
-- re-uploads when the management sends the request back for a correction.
-- Everything here dies with the decision: the documents' files are deleted
-- and the link's pointer is removed in the deciding transaction.

-- ----------------------------------------------------------------------------
-- Files: a registration document is an image or a PDF (10 MB, the default
-- size). The type CHECK is recreated whole with the new purpose.
-- ----------------------------------------------------------------------------
ALTER TABLE "files" DROP CONSTRAINT "files_content_type_for_purpose";
ALTER TABLE "files" ADD CONSTRAINT "files_content_type_for_purpose"
  CHECK (("content_type" IN ('image/jpeg', 'image/png', 'image/webp') AND "purpose" NOT IN ('data_export', 'patrol_note_audio', 'patrol_note_video', 'incident_audio', 'incident_video', 'incident_signature'))
      OR ("content_type" = 'image/png' AND "purpose" = 'incident_signature')
      OR ("content_type" = 'application/pdf' AND "purpose" IN ('document', 'request_attachment', 'community_attachment', 'complaint_evidence', 'vehicle_licence', 'approval_attachment', 'board_appeal_attachment', 'expense_invoice', 'decision_appeal_attachment', 'registration_document'))
      OR ("content_type" = 'application/zip' AND "purpose" = 'data_export')
      OR ("content_type" = 'audio/mp4' AND "purpose" IN ('patrol_note_audio', 'incident_audio'))
      OR ("content_type" IN ('video/mp4', 'video/quicktime') AND "purpose" IN ('patrol_note_video', 'incident_video')));

-- A record's upload with no account behind it (a registrant's document): no
-- owner from the start, and attached to its record when it is finalized
-- (an attached file is always ready). Every other file keeps the rule it
-- had: owned until attached.
ALTER TABLE "files" ADD COLUMN "record_upload" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "files" DROP CONSTRAINT "files_owned_or_attached";
ALTER TABLE "files" ADD CONSTRAINT "files_owned_or_attached"
  CHECK (("owner_account_id" IS NULL) = ("attached_at" IS NOT NULL OR "record_upload"));

-- ----------------------------------------------------------------------------
-- The request: `needs_correction` holds its personal data like `pending`
-- (it is still undecided) and says which codes the management asked about.
-- The expiry counts from the latest of creation, a correction asked for and
-- a resubmission. `status_link_seq` numbers the links emailed so far: the
-- link is derived from it when the email is sent, and only the newest works.
-- ----------------------------------------------------------------------------
ALTER TABLE "resident_registrations"
  ADD COLUMN "correction_codes" TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN "correction_requested_at" TIMESTAMPTZ(3),
  ADD COLUMN "resubmitted_at" TIMESTAMPTZ(3),
  ADD COLUMN "status_link_seq" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "resident_registrations_tenant_id_id_key"
  ON "resident_registrations"("tenant_id", "id");

DROP INDEX "resident_registrations_one_pending_per_email";
CREATE UNIQUE INDEX "resident_registrations_one_pending_per_email"
  ON "resident_registrations"("tenant_id", "email")
  WHERE "status" IN ('pending', 'needs_correction');

ALTER TABLE "resident_registrations" DROP CONSTRAINT "resident_registrations_pii_only_pending";
ALTER TABLE "resident_registrations" ADD CONSTRAINT "resident_registrations_pii_only_pending"
  CHECK (("status" IN ('pending', 'needs_correction')
          AND "full_name" IS NOT NULL AND "phone" IS NOT NULL AND "email" IS NOT NULL
          AND "id_document_type" IS NOT NULL AND "id_document_number" IS NOT NULL
          AND "nationality" IS NOT NULL AND "birth_date" IS NOT NULL)
      OR ("status" NOT IN ('pending', 'needs_correction')
          AND "full_name" IS NULL AND "phone" IS NULL AND "email" IS NULL
          AND "id_document_type" IS NULL AND "id_document_number" IS NULL
          AND "nationality" IS NULL AND "birth_date" IS NULL));
ALTER TABLE "resident_registrations" DROP CONSTRAINT "resident_registrations_decided_matches_status";
ALTER TABLE "resident_registrations" ADD CONSTRAINT "resident_registrations_decided_matches_status"
  CHECK (("status" IN ('pending', 'needs_correction')) = ("decided_at" IS NULL));
-- The codes exactly while the request waits for its correction (an empty
-- list otherwise), from the closed list (REASON_CODES.registrationCorrection),
-- with the time they were asked.
ALTER TABLE "resident_registrations" ADD CONSTRAINT "resident_registrations_correction_shape"
  CHECK (("status" = 'needs_correction') = (cardinality("correction_codes") > 0)
     AND cardinality("correction_codes") <= 4
     AND "correction_codes" <@ ARRAY['document_unreadable', 'document_missing',
           'document_mismatch', 'details_mismatch']::text[]
     AND (cardinality("correction_codes") = 0 OR "correction_requested_at" IS NOT NULL));
ALTER TABLE "resident_registrations" ADD CONSTRAINT "resident_registrations_status_link_seq_nonnegative"
  CHECK ("status_link_seq" >= 0);

-- ----------------------------------------------------------------------------
-- A registrant's documents. The file is a record upload (no account owns
-- it) from the moment the upload starts, so the limit counts live uploads
-- too; an upload never finalized is swept with its file, and this row goes
-- with the file's row (ON DELETE CASCADE). Rows never change: a wrong
-- document is removed and another uploaded.
-- ----------------------------------------------------------------------------
CREATE TABLE "registration_documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "registration_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "registration_documents_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "registration_documents_file_id_key"
  ON "registration_documents"("file_id");
CREATE INDEX "registration_documents_registration_idx"
  ON "registration_documents"("tenant_id", "registration_id", "created_at");
ALTER TABLE "registration_documents"
  ADD CONSTRAINT "registration_documents_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "registration_documents_registration_fkey"
  FOREIGN KEY ("tenant_id", "registration_id") REFERENCES "resident_registrations"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "registration_documents_file_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "registration_documents" ADD CONSTRAINT "registration_documents_kind"
  CHECK ("kind" IN ('ownership_proof', 'lease_proof', 'other_proof'));

REVOKE ALL ON "registration_documents" FROM jiwar_app;
GRANT SELECT, INSERT, DELETE ON "registration_documents" TO jiwar_app;
ALTER TABLE "registration_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "registration_documents" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "registration_documents"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ----------------------------------------------------------------------------
-- The status link's pointer: global (the link is read before the compound
-- is known), one per request, keyed by the HMAC of the link's token (the
-- token itself is derived when an email is sent and never stored). A new
-- link replaces the old one (delete, insert); the decision deletes it.
-- ----------------------------------------------------------------------------
CREATE TABLE "registration_status_links" (
    "token_hash" CHAR(64) NOT NULL,
    "tenant_id" UUID NOT NULL,
    "registration_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "registration_status_links_pkey" PRIMARY KEY ("token_hash")
);
CREATE UNIQUE INDEX "registration_status_links_one_per_registration"
  ON "registration_status_links"("tenant_id", "registration_id");
ALTER TABLE "registration_status_links"
  ADD CONSTRAINT "registration_status_links_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "registration_status_links_registration_fkey"
  FOREIGN KEY ("tenant_id", "registration_id") REFERENCES "resident_registrations"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "registration_status_links" ADD CONSTRAINT "registration_status_links_token_hash_hex"
  CHECK ("token_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "registration_status_links" ADD CONSTRAINT "registration_status_links_seq_positive"
  CHECK ("seq" > 0);

REVOKE ALL ON "registration_status_links" FROM jiwar_app;
GRANT SELECT, INSERT, DELETE ON "registration_status_links" TO jiwar_app;
