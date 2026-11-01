-- ============================================================================
-- Fit-out completion (ADR 0074): the common areas before and after works.
-- ============================================================================
--
-- The management (`permits.manage`) records a common area near a works
-- permit's unit as it stood before the works (one to ten `fitout_photo`
-- files and an optional note the household reads) and, once that is
-- recorded, as it stood after them: one record per area and stage. A
-- record and its photos never change and never go: they are the evidence
-- a damage claim stands on.

CREATE TABLE "permit_area_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "permit_id" UUID NOT NULL,
    "permit_kind" "unit_permit_kind" NOT NULL DEFAULT 'works',
    "common_area_id" UUID NOT NULL,
    "phase" TEXT NOT NULL,
    "note" TEXT,
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "permit_area_records_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "permit_area_records_tenant_id_id_key" ON "permit_area_records"("tenant_id", "id");
CREATE UNIQUE INDEX "permit_area_records_stage_key"
  ON "permit_area_records"("permit_id", "common_area_id", "phase");
CREATE INDEX "permit_area_records_permit_idx" ON "permit_area_records"("tenant_id", "permit_id");
ALTER TABLE "permit_area_records"
  ADD CONSTRAINT "permit_area_records_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_area_records_permit_fkey"
  FOREIGN KEY ("tenant_id", "permit_id", "permit_kind")
  REFERENCES "unit_permits"("tenant_id", "id", "kind")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_area_records_common_area_fkey"
  FOREIGN KEY ("tenant_id", "common_area_id") REFERENCES "common_areas"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_area_records_recorded_by_fkey"
  FOREIGN KEY ("tenant_id", "recorded_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "permit_area_records" ADD CONSTRAINT "permit_area_records_shape"
  CHECK ("permit_kind" = 'works'
     AND "phase" IN ('before', 'after')
     AND ("note" IS NULL OR char_length("note") BETWEEN 1 AND 500));
CREATE TRIGGER permit_area_records_immutable
  BEFORE UPDATE OR DELETE ON "permit_area_records"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER permit_area_records_no_truncate
  BEFORE TRUNCATE ON "permit_area_records"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

CREATE TABLE "permit_area_photos" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "record_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "permit_area_photos_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "permit_area_photos_file_id_key" ON "permit_area_photos"("file_id");
CREATE INDEX "permit_area_photos_record_idx" ON "permit_area_photos"("tenant_id", "record_id");
ALTER TABLE "permit_area_photos"
  ADD CONSTRAINT "permit_area_photos_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_area_photos_record_fkey"
  FOREIGN KEY ("tenant_id", "record_id") REFERENCES "permit_area_records"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_area_photos_file_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE TRIGGER permit_area_photos_immutable
  BEFORE UPDATE OR DELETE ON "permit_area_photos"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER permit_area_photos_no_truncate
  BEFORE TRUNCATE ON "permit_area_photos"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

GRANT SELECT, INSERT ON "permit_area_records" TO jiwar_app;
GRANT SELECT, INSERT ON "permit_area_photos" TO jiwar_app;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['permit_area_records', 'permit_area_photos'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
