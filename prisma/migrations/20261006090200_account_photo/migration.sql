-- ============================================================================
-- Phase 4.3 — a resident's own photo (ADR 0031). The file is attached to the
-- account (it leaves its uploader, like a worker's photo) and the account
-- points at it. An account has at most one photo and a photo one account.
-- The pointer is cleared in the transaction that marks the file deleted,
-- before the sweep removes the row (RESTRICT).
-- ============================================================================

ALTER TABLE "accounts" ADD COLUMN "photo_file_id" UUID;
CREATE UNIQUE INDEX "accounts_photo_file_id_key"
  ON "accounts"("tenant_id", "photo_file_id") WHERE "photo_file_id" IS NOT NULL;
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_tenant_id_photo_file_id_fkey"
  FOREIGN KEY ("tenant_id", "photo_file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- An erased account keeps no photo either.
ALTER TABLE "accounts" DROP CONSTRAINT "accounts_erased_shape";
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_erased_shape"
  CHECK (("status" = 'erased'
          AND "full_name" IS NULL AND "phone" IS NULL AND "email" IS NULL
          AND "id_document_type" IS NULL AND "id_document_number" IS NULL
          AND "nationality" IS NULL AND "birth_date" IS NULL
          AND "photo_file_id" IS NULL)
      OR ("status" <> 'erased'
          AND "full_name" IS NOT NULL AND "email" IS NOT NULL
          AND "id_document_type" IS NOT NULL AND "id_document_number" IS NOT NULL
          AND "nationality" IS NOT NULL
          -- Only a frozen account has no phone (the number left it).
          AND ("phone" IS NOT NULL OR "status" = 'frozen')));
