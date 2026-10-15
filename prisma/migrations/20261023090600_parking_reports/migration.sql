-- ============================================================================
-- Vehicles and parking (ADR 0045): residents report wrongly parked vehicles
-- to security.
--
-- A report is about a plate, never a unit: the reporter is told nothing of
-- whom it matches. The staff close it with a reason code or turn it into a
-- fine; either is final. The fine carries nothing of the report, so the
-- reported unit never learns who reported. The reporter's note and photo go
-- with their erasure; the row stays.
-- ============================================================================

CREATE TYPE "parking_report_status" AS ENUM ('open', 'closed', 'converted');

CREATE TABLE "parking_reports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "reporter_account_id" UUID NOT NULL,
    "plate" TEXT NOT NULL,
    "plate_key" TEXT GENERATED ALWAYS AS (
      translate(replace("plate", ' ', ''), '٠١٢٣٤٥٦٧٨٩', '0123456789')
    ) STORED,
    "location" TEXT NOT NULL,
    "note" TEXT,
    "note_cleared_at" TIMESTAMPTZ(3),
    "photo_file_id" UUID,
    "status" "parking_report_status" NOT NULL DEFAULT 'open',
    "close_reason" TEXT,
    "fine_id" UUID,
    "handled_by_account_id" UUID,
    "handled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "parking_reports_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "parking_reports_tenant_id_id_key" ON "parking_reports"("tenant_id", "id");
CREATE UNIQUE INDEX "parking_reports_number_key" ON "parking_reports"("tenant_id", "number");
CREATE UNIQUE INDEX "parking_reports_fine_key" ON "parking_reports"("tenant_id", "fine_id");
CREATE INDEX "parking_reports_status_idx" ON "parking_reports"("tenant_id", "status", "created_at", "id");
CREATE INDEX "parking_reports_reporter_idx"
  ON "parking_reports"("tenant_id", "reporter_account_id", "created_at", "id");
CREATE INDEX "parking_reports_plate_key_idx" ON "parking_reports"("tenant_id", "plate_key");
ALTER TABLE "parking_reports"
  ADD CONSTRAINT "parking_reports_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "parking_reports_tenant_id_reporter_fkey"
  FOREIGN KEY ("tenant_id", "reporter_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "parking_reports_tenant_id_photo_fkey"
  FOREIGN KEY ("tenant_id", "photo_file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "parking_reports_tenant_id_fine_id_fkey"
  FOREIGN KEY ("tenant_id", "fine_id") REFERENCES "vehicle_fines"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "parking_reports_tenant_id_handled_by_fkey"
  FOREIGN KEY ("tenant_id", "handled_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "parking_reports" ADD CONSTRAINT "parking_reports_number_positive"
  CHECK ("number" > 0);
ALTER TABLE "parking_reports" ADD CONSTRAINT "parking_reports_text_length"
  CHECK (char_length("plate") BETWEEN 1 AND 12 AND char_length("location") BETWEEN 1 AND 120);
ALTER TABLE "parking_reports" ADD CONSTRAINT "parking_reports_note_length"
  CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 500);
ALTER TABLE "parking_reports" ADD CONSTRAINT "parking_reports_note_cleared"
  CHECK ("note_cleared_at" IS NULL OR "note" IS NULL);
-- Nullable columns only under IS [NOT] NULL; status is NOT NULL.
ALTER TABLE "parking_reports" ADD CONSTRAINT "parking_reports_state_shape"
  CHECK (("status" = 'converted') = ("fine_id" IS NOT NULL)
     AND ("status" = 'closed') = ("close_reason" IS NOT NULL)
     AND ("status" = 'open') = ("handled_at" IS NULL)
     AND ("handled_at" IS NULL) = ("handled_by_account_id" IS NULL));
-- REASON_CODES.parkingReportClose; a unit test keeps the two in step.
ALTER TABLE "parking_reports" ADD CONSTRAINT "parking_reports_close_reason"
  CHECK ("close_reason" IS NULL
      OR "close_reason" IN ('resolved', 'vehicle_not_found', 'duplicate', 'not_a_violation'));

CREATE FUNCTION parking_report_keeps_its_words() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number"
     AND NEW."reporter_account_id" = OLD."reporter_account_id"
     AND NEW."plate" = OLD."plate"
     AND NEW."location" = OLD."location"
     AND NEW."created_at" = OLD."created_at"
     -- The note stays, or goes once (the reporter's erasure).
     AND ((NEW."note" IS NOT DISTINCT FROM OLD."note"
           AND NEW."note_cleared_at" IS NOT DISTINCT FROM OLD."note_cleared_at")
          OR (OLD."note_cleared_at" IS NULL AND NEW."note" IS NULL
              AND NEW."note_cleared_at" IS NOT NULL))
     -- The photo stays, or goes.
     AND (NEW."photo_file_id" IS NOT DISTINCT FROM OLD."photo_file_id"
          OR NEW."photo_file_id" IS NULL)
     -- Handled once, never rewritten.
     AND ((NEW."status" = OLD."status"
           AND NEW."close_reason" IS NOT DISTINCT FROM OLD."close_reason"
           AND NEW."fine_id" IS NOT DISTINCT FROM OLD."fine_id"
           AND NEW."handled_by_account_id" IS NOT DISTINCT FROM OLD."handled_by_account_id"
           AND NEW."handled_at" IS NOT DISTINCT FROM OLD."handled_at")
          OR OLD."status" = 'open') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'parking_reports: a report keeps its words and is handled once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER parking_reports_keep_words
  BEFORE UPDATE OR DELETE ON "parking_reports"
  FOR EACH ROW EXECUTE FUNCTION parking_report_keeps_its_words();
CREATE TRIGGER parking_reports_keep_words_truncate
  BEFORE TRUNCATE ON "parking_reports"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "parking_reports" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "parking_reports" TO jiwar_app;
ALTER TABLE "parking_reports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "parking_reports" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "parking_reports"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
