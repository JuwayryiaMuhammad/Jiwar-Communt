-- ============================================================================
-- A bid's documents through its bid link (ADR 0088, deviation 4 closed): a
-- company that is not registered attaches its offer, drawings or papers to
-- the bid it sends with no account.
--
-- Each is a `tender_bid` file (the purpose already exists, images or a PDF,
-- 10 MB: the files' CHECKs list it, and nothing about them changes), a
-- record upload owned by no account from the moment the upload starts, kept
-- here by its file's id. Uploaded while the tender takes bids and the link's
-- invitation has no live bid, it waits on the invitation (`bid_id` NULL)
-- until the bid is sent, which takes it (`bid_id` set, once); the documents
-- the bid does not name are deleted then. A withdrawn bid's documents, and a
-- draft removed, are deleted with their files: this row goes with the file's
-- row (ON DELETE CASCADE). Nothing else changes; staff read them only once
-- the tender is opened, as the bid's amount and terms.
-- ============================================================================

CREATE TABLE "tender_bid_documents" (
    "file_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "tender_id" UUID NOT NULL,
    "invitation_id" UUID NOT NULL,
    "bid_id" UUID,
    "title" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "attached_at" TIMESTAMPTZ(3),
    CONSTRAINT "tender_bid_documents_pkey" PRIMARY KEY ("file_id")
);
CREATE UNIQUE INDEX "tender_bid_documents_tenant_id_file_id_key"
  ON "tender_bid_documents"("tenant_id", "file_id");
CREATE INDEX "tender_bid_documents_invitation_idx"
  ON "tender_bid_documents"("tenant_id", "invitation_id", "created_at", "file_id");
CREATE INDEX "tender_bid_documents_bid_idx"
  ON "tender_bid_documents"("tenant_id", "bid_id") WHERE "bid_id" IS NOT NULL;
ALTER TABLE "tender_bid_documents"
  ADD CONSTRAINT "tender_bid_documents_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tender_bid_documents_tender_fkey"
  FOREIGN KEY ("tenant_id", "tender_id") REFERENCES "tenders"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tender_bid_documents_invitation_fkey"
  FOREIGN KEY ("tenant_id", "invitation_id") REFERENCES "tender_invitations"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tender_bid_documents_bid_fkey"
  FOREIGN KEY ("tenant_id", "bid_id") REFERENCES "tender_bids"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tender_bid_documents_file_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE RESTRICT;
-- TENDER_LIMITS.bidDocumentTitle; attached exactly when it is the bid's.
ALTER TABLE "tender_bid_documents" ADD CONSTRAINT "tender_bid_documents_title_length"
  CHECK (char_length("title") BETWEEN 1 AND 120);
ALTER TABLE "tender_bid_documents" ADD CONSTRAINT "tender_bid_documents_attached_shape"
  CHECK (("bid_id" IS NULL) = ("attached_at" IS NULL));

-- A document joins its bid once, and nothing else of it ever changes; it
-- goes only with its file (the cascade).
CREATE FUNCTION tender_bid_documents_kept() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."file_id" <> OLD."file_id" OR NEW."tenant_id" <> OLD."tenant_id"
     OR NEW."tender_id" <> OLD."tender_id" OR NEW."invitation_id" <> OLD."invitation_id"
     OR NEW."title" <> OLD."title" OR NEW."created_at" <> OLD."created_at"
     OR OLD."bid_id" IS NOT NULL THEN
    RAISE EXCEPTION 'tender_bid_documents: a document joins its bid once and otherwise never changes'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tender_bid_documents_kept
  BEFORE UPDATE ON "tender_bid_documents"
  FOR EACH ROW EXECUTE FUNCTION tender_bid_documents_kept();

REVOKE ALL ON "tender_bid_documents" FROM jiwar_app;
-- DELETE as registration_documents': the file's purge cascades to the row.
GRANT SELECT, INSERT, DELETE ON "tender_bid_documents" TO jiwar_app;
GRANT UPDATE ("bid_id", "attached_at") ON "tender_bid_documents" TO jiwar_app;
ALTER TABLE "tender_bid_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tender_bid_documents" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tender_bid_documents"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
