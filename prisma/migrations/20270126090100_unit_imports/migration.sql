-- ============================================================================
-- The unit register (ADR 0072): sheets of units, and of residents with their
-- places, the way asset sheets are (ADR 0064). Uploading checks the sheet
-- whole and keeps what is wrong (`{ line, field, code }`, never a cell's
-- text): valid or invalid. Applying a valid one checks it again under the
-- locks it needs, then creates every row in one transaction, or none.
--
-- A residents sheet holds people's names, phones, emails and document
-- numbers, so its file is kept only while the import may still be applied:
-- an invalid one lets it go at once, an applied one when it is applied, and
-- a valid one a day after the upload, when it expires. A units sheet holds
-- nothing personal and is kept, as an asset sheet is.
-- ============================================================================

CREATE TABLE "unit_imports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "file_id" UUID,
    "status" TEXT NOT NULL,
    "row_count" INTEGER NOT NULL,
    "error_count" INTEGER NOT NULL,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "created_by_account_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "applied_at" TIMESTAMPTZ(3),
    "applied_by_account_id" UUID,
    "applied_count" INTEGER,
    CONSTRAINT "unit_imports_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "unit_imports_tenant_id_id_key" ON "unit_imports"("tenant_id", "id");
-- A file is one import's.
CREATE UNIQUE INDEX "unit_imports_file_id_key" ON "unit_imports"("file_id")
  WHERE "file_id" IS NOT NULL;
CREATE INDEX "unit_imports_list_idx" ON "unit_imports"("tenant_id", "created_at" DESC, "id" DESC);
-- The expiry sweep's: valid imports, oldest first.
CREATE INDEX "unit_imports_valid_idx" ON "unit_imports"("tenant_id", "created_at")
  WHERE "status" = 'valid';
ALTER TABLE "unit_imports" ADD CONSTRAINT "unit_imports_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "unit_imports" ADD CONSTRAINT "unit_imports_file_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "unit_imports" ADD CONSTRAINT "unit_imports_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "unit_imports" ADD CONSTRAINT "unit_imports_applied_by_fkey"
  FOREIGN KEY ("tenant_id", "applied_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "unit_imports" ADD CONSTRAINT "unit_imports_kind_known"
  CHECK ("kind" IN ('units', 'residents'));
ALTER TABLE "unit_imports" ADD CONSTRAINT "unit_imports_status_known"
  CHECK ("status" IN ('valid', 'invalid', 'applied', 'expired'));
ALTER TABLE "unit_imports" ADD CONSTRAINT "unit_imports_counts_range"
  CHECK ("row_count" BETWEEN 0 AND 2000 AND "error_count" >= 0
     AND jsonb_typeof("errors") = 'array' AND jsonb_array_length("errors") <= 100);
-- Valid: no error, never applied; invalid: errors, never applied; applied:
-- once, with what it created; expired: valid once, never applied.
ALTER TABLE "unit_imports" ADD CONSTRAINT "unit_imports_state_shape"
  CHECK (("status" IN ('valid', 'expired') AND "error_count" = 0 AND "applied_at" IS NULL AND "applied_by_account_id" IS NULL AND "applied_count" IS NULL)
      OR ("status" = 'invalid' AND "error_count" > 0 AND "applied_at" IS NULL AND "applied_by_account_id" IS NULL AND "applied_count" IS NULL)
      OR ("status" = 'applied' AND "error_count" = 0 AND "applied_at" IS NOT NULL AND "applied_count" IS NOT NULL));
-- A units sheet is kept; a residents sheet only while it may be applied.
ALTER TABLE "unit_imports" ADD CONSTRAINT "unit_imports_file_kept"
  CHECK (CASE "kind"
           WHEN 'units' THEN "file_id" IS NOT NULL
           ELSE ("status" = 'valid') = ("file_id" IS NOT NULL)
         END);

-- Changed in place under FOR UPDATE (checked, applied, expired); never deleted.
REVOKE ALL ON "unit_imports" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "unit_imports" TO jiwar_app;
ALTER TABLE "unit_imports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "unit_imports" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "unit_imports"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
