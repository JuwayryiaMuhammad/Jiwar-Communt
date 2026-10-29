-- ============================================================================
-- Meter reading imports (ADR 0066): a sheet of readings, checked whole at the
-- upload and applied once, every row or none, like the asset register's
-- imports (ADR 0064). Problems name a line, a column and a code, never a
-- cell's text. An imported reading names its import.
-- ============================================================================

CREATE TABLE "meter_reading_imports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "row_count" INTEGER NOT NULL,
    "error_count" INTEGER NOT NULL,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "created_by_account_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "applied_at" TIMESTAMPTZ(3),
    "applied_by_account_id" UUID,
    "applied_count" INTEGER,
    CONSTRAINT "meter_reading_imports_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "meter_reading_imports_tenant_id_id_key" ON "meter_reading_imports"("tenant_id", "id");
CREATE UNIQUE INDEX "meter_reading_imports_file_id_key" ON "meter_reading_imports"("file_id");
CREATE INDEX "meter_reading_imports_list_idx" ON "meter_reading_imports"("tenant_id", "created_at" DESC, "id" DESC);
ALTER TABLE "meter_reading_imports" ADD CONSTRAINT "meter_reading_imports_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "meter_reading_imports" ADD CONSTRAINT "meter_reading_imports_file_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "meter_reading_imports" ADD CONSTRAINT "meter_reading_imports_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "meter_reading_imports" ADD CONSTRAINT "meter_reading_imports_applied_by_fkey"
  FOREIGN KEY ("tenant_id", "applied_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "meter_reading_imports" ADD CONSTRAINT "meter_reading_imports_status_known"
  CHECK ("status" IN ('valid', 'invalid', 'applied'));
ALTER TABLE "meter_reading_imports" ADD CONSTRAINT "meter_reading_imports_counts_range"
  CHECK ("row_count" BETWEEN 0 AND 2000 AND "error_count" >= 0
     AND jsonb_typeof("errors") = 'array' AND jsonb_array_length("errors") <= 100);
-- Valid: no error, never applied; invalid: errors, never applied; applied:
-- once, with how many readings it wrote.
ALTER TABLE "meter_reading_imports" ADD CONSTRAINT "meter_reading_imports_state_shape"
  CHECK (("status" = 'valid' AND "error_count" = 0 AND "applied_at" IS NULL AND "applied_count" IS NULL)
      OR ("status" = 'invalid' AND "error_count" > 0 AND "applied_at" IS NULL AND "applied_count" IS NULL)
      OR ("status" = 'applied' AND "error_count" = 0 AND "applied_at" IS NOT NULL AND "applied_count" IS NOT NULL));

ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_import_fkey"
  FOREIGN KEY ("tenant_id", "import_id") REFERENCES "meter_reading_imports"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ----------------------------------------------------------------------------
-- Grants: an import changes in place under its FOR UPDATE.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "meter_reading_imports" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "meter_reading_imports" TO jiwar_app;

ALTER TABLE "meter_reading_imports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meter_reading_imports" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "meter_reading_imports"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
