-- ============================================================================
-- R11c-1a (ADR 0069): where the fees go, told to everyone who pays them.
--
-- The budget and its expenses are the staff's and the board's (ADR 0055);
-- tenants, who often pay the charges, saw nothing. A spending report is a
-- snapshot the finance staff publish of a budget as of a day: each
-- category's allowance and what was spent on it — never an expense, a
-- vendor or a name — and the improvements it paid for, in the staff's
-- words, each may cite the board's published decision. Published in one
-- act and never changed after: a later report is another snapshot.
-- ============================================================================

CREATE TABLE "finance_spending_reports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "budget_id" UUID NOT NULL,
    "fiscal_year" SMALLINT NOT NULL,
    "starts_on" DATE NOT NULL,
    "as_of" DATE NOT NULL,
    "summary_en" TEXT,
    "summary_ar" TEXT,
    "published_by" UUID NOT NULL,
    "published_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    CONSTRAINT "finance_spending_reports_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_spending_reports_tenant_id_id_key"
  ON "finance_spending_reports"("tenant_id", "id");
-- One snapshot of a budget a day.
CREATE UNIQUE INDEX "finance_spending_reports_day_key"
  ON "finance_spending_reports"("tenant_id", "budget_id", "as_of");
CREATE INDEX "finance_spending_reports_published_idx"
  ON "finance_spending_reports"("tenant_id", "published_at", "id");
ALTER TABLE "finance_spending_reports"
  ADD CONSTRAINT "finance_spending_reports_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_spending_reports_budget_fkey"
  FOREIGN KEY ("tenant_id", "budget_id") REFERENCES "finance_budgets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_spending_reports_published_by_fkey"
  FOREIGN KEY ("tenant_id", "published_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_spending_reports" ADD CONSTRAINT "finance_spending_reports_dates"
  CHECK ("as_of" >= "starts_on");
ALTER TABLE "finance_spending_reports" ADD CONSTRAINT "finance_spending_reports_summary"
  CHECK (("summary_en" IS NULL) = ("summary_ar" IS NULL)
     AND ("summary_en" IS NULL OR char_length("summary_en") BETWEEN 1 AND 2000)
     AND ("summary_ar" IS NULL OR char_length("summary_ar") BETWEEN 1 AND 2000));

CREATE TABLE "finance_spending_report_lines" (
    "tenant_id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "allowance" DECIMAL(14,2) NOT NULL,
    "spent" DECIMAL(14,2) NOT NULL,
    CONSTRAINT "finance_spending_report_lines_pkey" PRIMARY KEY ("report_id", "category")
);
CREATE INDEX "finance_spending_report_lines_tenant_idx"
  ON "finance_spending_report_lines"("tenant_id", "report_id");
ALTER TABLE "finance_spending_report_lines"
  ADD CONSTRAINT "finance_spending_report_lines_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_spending_report_lines_report_fkey"
  FOREIGN KEY ("tenant_id", "report_id") REFERENCES "finance_spending_reports"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_spending_report_lines" ADD CONSTRAINT "finance_spending_report_lines_figures"
  CHECK ("allowance" >= 0 AND "spent" >= 0);
ALTER TABLE "finance_spending_report_lines" ADD CONSTRAINT "finance_spending_report_lines_category"
  CHECK ("category" IN ('security', 'cleaning', 'landscaping', 'maintenance', 'utilities',
                        'staff', 'insurance', 'administration', 'reserve_fund', 'other'));

CREATE TABLE "finance_spending_report_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL,
    "decision_publication_id" UUID,
    "text_en" TEXT NOT NULL,
    "text_ar" TEXT NOT NULL,
    CONSTRAINT "finance_spending_report_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_spending_report_items_tenant_id_id_key"
  ON "finance_spending_report_items"("tenant_id", "id");
CREATE UNIQUE INDEX "finance_spending_report_items_position_key"
  ON "finance_spending_report_items"("tenant_id", "report_id", "position");
ALTER TABLE "finance_spending_report_items"
  ADD CONSTRAINT "finance_spending_report_items_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_spending_report_items_report_fkey"
  FOREIGN KEY ("tenant_id", "report_id") REFERENCES "finance_spending_reports"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_spending_report_items_decision_fkey"
  FOREIGN KEY ("tenant_id", "decision_publication_id") REFERENCES "board_publications"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_spending_report_items" ADD CONSTRAINT "finance_spending_report_items_shape"
  CHECK ("position" BETWEEN 1 AND 20
     AND char_length("text_en") BETWEEN 1 AND 500
     AND char_length("text_ar") BETWEEN 1 AND 500);

CREATE TRIGGER finance_spending_reports_immutable
  BEFORE UPDATE OR DELETE ON "finance_spending_reports"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER finance_spending_reports_no_truncate
  BEFORE TRUNCATE ON "finance_spending_reports"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER finance_spending_report_lines_immutable
  BEFORE UPDATE OR DELETE ON "finance_spending_report_lines"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER finance_spending_report_lines_no_truncate
  BEFORE TRUNCATE ON "finance_spending_report_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER finance_spending_report_items_immutable
  BEFORE UPDATE OR DELETE ON "finance_spending_report_items"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER finance_spending_report_items_no_truncate
  BEFORE TRUNCATE ON "finance_spending_report_items"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Grants: a report, its lines and its items are only ever inserted.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "finance_spending_reports", "finance_spending_report_lines",
  "finance_spending_report_items" FROM jiwar_app;
GRANT SELECT, INSERT ON "finance_spending_reports", "finance_spending_report_lines",
  "finance_spending_report_items" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_spending_reports', 'finance_spending_report_lines',
                           'finance_spending_report_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
