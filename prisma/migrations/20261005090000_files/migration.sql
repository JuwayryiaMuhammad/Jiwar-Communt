-- ============================================================================
-- Phase 4.2 — files (ADR 0029). One row per object in the private bucket;
-- the object key is derived, `t/<tenant_id>/<id>`, and never stored. A row
-- is `pending` from the presigned PUT until finalize checks the bytes, then
-- `ready`. A deleted row keeps its id until the sweep has deleted the object,
-- so an object never outlives the row that names it. No file name is kept.
-- ============================================================================

CREATE TYPE "file_purpose" AS ENUM ('worker_photo', 'document');
CREATE TYPE "file_status" AS ENUM ('pending', 'ready');

CREATE TABLE "files" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "owner_account_id" UUID NOT NULL,
    "purpose" "file_purpose" NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "status" "file_status" NOT NULL DEFAULT 'pending',
    "upload_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "finalized_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "files_tenant_id_id_key" ON "files"("tenant_id", "id");
-- The owner's live files: the pending cap, erasure.
CREATE INDEX "files_tenant_id_owner_account_id_idx"
  ON "files"("tenant_id", "owner_account_id") WHERE "deleted_at" IS NULL;
-- The sweep: uploads never finalized, and objects still to delete.
CREATE INDEX "files_pending_expiry_idx"
  ON "files"("upload_expires_at") WHERE "status" = 'pending' AND "deleted_at" IS NULL;
CREATE INDEX "files_deleted_at_idx" ON "files"("deleted_at") WHERE "deleted_at" IS NOT NULL;
ALTER TABLE "files" ADD CONSTRAINT "files_tenant_id_owner_account_id_fkey"
  FOREIGN KEY ("tenant_id", "owner_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The purposes' types and limits (FILE_PURPOSES in src/core/files/purposes.ts).
ALTER TABLE "files" ADD CONSTRAINT "files_content_type_for_purpose"
  CHECK ("content_type" IN ('image/jpeg', 'image/png', 'image/webp')
         OR ("content_type" = 'application/pdf' AND "purpose" = 'document'));
ALTER TABLE "files" ADD CONSTRAINT "files_size_for_purpose"
  CHECK ("size_bytes" > 0 AND "size_bytes" <= CASE "purpose"
           WHEN 'worker_photo' THEN 5242880
           ELSE 10485760 END);
ALTER TABLE "files" ADD CONSTRAINT "files_ready_matches_finalized"
  CHECK (("status" = 'ready') = ("finalized_at" IS NOT NULL));

GRANT SELECT, INSERT, UPDATE, DELETE ON "files" TO jiwar_app;

ALTER TABLE "files" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "files" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "files"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
