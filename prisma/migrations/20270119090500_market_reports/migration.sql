-- ============================================================================
-- The market (ADR 0071): residents report a listing, once each, with a code
-- and an optional note for the staff. When reports from enough distinct
-- units are open on a live listing (`market_settings.report_hide_threshold`)
-- it leaves the market for review at once, in the report's transaction under
-- the listing's lock. The handlers close each report with an outcome;
-- `removed` takes the listing off the market.
--
-- Personal data here: `note` (the reporter's words). An erasure clears it.
-- ============================================================================

CREATE TYPE "market_report_status" AS ENUM ('open', 'closed');

CREATE TABLE "market_listing_reports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "reporter_account_id" UUID NOT NULL,
    "reporter_unit_id" UUID NOT NULL,
    "reason_code" TEXT NOT NULL,
    "note" TEXT,
    "status" "market_report_status" NOT NULL DEFAULT 'open',
    "outcome" TEXT,
    "closed_by" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "market_listing_reports_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "market_listing_reports_tenant_id_id_key"
  ON "market_listing_reports"("tenant_id", "id");
-- One report a listing and reporter: checked first under the listing's lock.
CREATE UNIQUE INDEX "market_listing_reports_one_per_reporter"
  ON "market_listing_reports"("tenant_id", "listing_id", "reporter_account_id");
CREATE INDEX "market_listing_reports_queue_idx"
  ON "market_listing_reports"("tenant_id", "status", "created_at" DESC, "id" DESC);
ALTER TABLE "market_listing_reports"
  ADD CONSTRAINT "market_listing_reports_tenant_id_listing_fkey"
  FOREIGN KEY ("tenant_id", "listing_id") REFERENCES "market_listings"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "market_listing_reports_tenant_id_reporter_fkey"
  FOREIGN KEY ("tenant_id", "reporter_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "market_listing_reports_tenant_id_reporter_unit_fkey"
  FOREIGN KEY ("tenant_id", "reporter_unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "market_listing_reports_tenant_id_closed_by_fkey"
  FOREIGN KEY ("tenant_id", "closed_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "market_listing_reports" ADD CONSTRAINT "market_listing_reports_reason"
  CHECK ("reason_code" IN ('scam', 'prohibited', 'misleading', 'harassment', 'privacy', 'other'));
ALTER TABLE "market_listing_reports" ADD CONSTRAINT "market_listing_reports_note_length"
  CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 1000);
-- Closed has its outcome, its handler and its time; open has none.
ALTER TABLE "market_listing_reports" ADD CONSTRAINT "market_listing_reports_closed_shape"
  CHECK ((("status" = 'closed') = ("closed_at" IS NOT NULL))
     AND (("status" = 'closed') = ("closed_by" IS NOT NULL))
     AND (("status" = 'closed') = ("outcome" IS NOT NULL))
     AND ("outcome" IS NULL OR "outcome" IN ('no_action', 'removed', 'warned')));

-- What was reported, by whom and from where never changes; a closed report
-- stays closed; the only other change is an erasure clearing the note.
CREATE FUNCTION market_listing_report_keeps_its_reporter() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."listing_id" = OLD."listing_id"
     AND NEW."reporter_account_id" = OLD."reporter_account_id"
     AND NEW."reporter_unit_id" = OLD."reporter_unit_id"
     AND NEW."reason_code" = OLD."reason_code"
     AND NEW."created_at" = OLD."created_at"
     AND (NEW."note" IS NOT DISTINCT FROM OLD."note" OR NEW."note" IS NULL)
     AND (OLD."status" = 'open'
          OR (NEW."status" = 'closed'
              AND NEW."outcome" IS NOT DISTINCT FROM OLD."outcome"
              AND NEW."closed_by" IS NOT DISTINCT FROM OLD."closed_by"
              AND NEW."closed_at" IS NOT DISTINCT FROM OLD."closed_at")) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'market_listing_reports: a report keeps its reporter, and a closed one stays closed (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER market_listing_reports_keep_reporter
  BEFORE UPDATE OR DELETE ON "market_listing_reports"
  FOR EACH ROW EXECUTE FUNCTION market_listing_report_keeps_its_reporter();
CREATE TRIGGER market_listing_reports_keep_reporter_truncate
  BEFORE TRUNCATE ON "market_listing_reports"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "market_listing_reports" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "market_listing_reports" TO jiwar_app;
ALTER TABLE "market_listing_reports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "market_listing_reports" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "market_listing_reports"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
