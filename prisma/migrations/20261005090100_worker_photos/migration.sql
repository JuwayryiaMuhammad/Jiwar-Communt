-- ============================================================================
-- Phase 4.2 — worker photos and card language (ADR 0029, 0030). A file can
-- be attached to a record: it leaves its uploader (owner_account_id NULL),
-- so the uploader's erasure no longer takes it, and only the record's own
-- views read it. A worker has at most one photo, and a photo one worker.
-- ============================================================================

ALTER TABLE "files" ALTER COLUMN "owner_account_id" DROP NOT NULL;
ALTER TABLE "files" ADD COLUMN "attached_at" TIMESTAMPTZ(3);
ALTER TABLE "files" ADD CONSTRAINT "files_owned_or_attached"
  CHECK (("owner_account_id" IS NULL) = ("attached_at" IS NOT NULL));
ALTER TABLE "files" ADD CONSTRAINT "files_attached_is_ready"
  CHECK ("attached_at" IS NULL OR "status" = 'ready');

ALTER TABLE "domestic_workers" ADD COLUMN "photo_file_id" UUID;
CREATE UNIQUE INDEX "domestic_workers_photo_file_id_key"
  ON "domestic_workers"("tenant_id", "photo_file_id") WHERE "photo_file_id" IS NOT NULL;
-- RESTRICT: the pointer is cleared in the transaction that marks the file
-- deleted, before the sweep removes the row.
ALTER TABLE "domestic_workers" ADD CONSTRAINT "domestic_workers_tenant_id_photo_file_id_fkey"
  FOREIGN KEY ("tenant_id", "photo_file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The card's language (labels are the client's): set at registration.
ALTER TABLE "domestic_workers" ADD CONSTRAINT "domestic_workers_preferred_language"
  CHECK ("preferred_language" IN ('ar', 'en'));
