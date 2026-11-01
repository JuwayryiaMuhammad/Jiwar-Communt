-- ============================================================================
-- The monthly board report (ADR 0075).
--
-- On the first days of a month the board is sent the report of the month
-- before: governance's own figures (requests and appeals raised and
-- decided, polls and elections closed, meetings held, action items done and
-- open) and the overview's sections the domains register (ADR 0055:
-- finance's money, security's incidents and violations). A sitting member
-- or the manager may draw a month again on demand: a new version, the old
-- ones kept. A version never changes; its PDF, with the compound's logo
-- when it has one, is drawn on demand.
--
-- The rules gain the logo (a `compound_logo` file, a PNG or a JPEG) and
-- whether the report is sent monthly (on by default).
-- ============================================================================

ALTER TABLE "governance_rules"
  ADD COLUMN "report_logo_file_id" UUID,
  ADD COLUMN "board_report_monthly" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "governance_rules"
  ADD CONSTRAINT "governance_rules_tenant_id_logo_fkey"
  FOREIGN KEY ("tenant_id", "report_logo_file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "board_reports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "period" DATE NOT NULL,
    "version" SMALLINT NOT NULL,
    "contents" JSONB NOT NULL,
    "generated_at" TIMESTAMPTZ(3) NOT NULL,
    "generated_by_account_id" UUID,
    CONSTRAINT "board_reports_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "board_reports_tenant_id_id_key" ON "board_reports"("tenant_id", "id");
CREATE UNIQUE INDEX "board_reports_version_key" ON "board_reports"("tenant_id", "period", "version");
CREATE INDEX "board_reports_latest_idx" ON "board_reports"("tenant_id", "generated_at", "id");
ALTER TABLE "board_reports"
  ADD CONSTRAINT "board_reports_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "board_reports_tenant_id_generated_by_fkey"
  FOREIGN KEY ("tenant_id", "generated_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- A month is its first day; versions count from 1; the sweep's carry no
-- account.
ALTER TABLE "board_reports" ADD CONSTRAINT "board_reports_shape"
  CHECK (extract(day FROM "period") = 1
     AND "version" >= 1
     AND jsonb_typeof("contents") = 'object');
CREATE TRIGGER board_reports_immutable_rows
  BEFORE UPDATE OR DELETE ON "board_reports"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER board_reports_immutable_truncate
  BEFORE TRUNCATE ON "board_reports"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "board_reports" FROM jiwar_app;
GRANT SELECT, INSERT ON "board_reports" TO jiwar_app;
ALTER TABLE "board_reports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "board_reports" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "board_reports"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
