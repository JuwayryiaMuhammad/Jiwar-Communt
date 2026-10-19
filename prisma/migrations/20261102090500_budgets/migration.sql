-- ============================================================================
-- Finance (ADR 0055): the compound's annual budget. The accountant drafts
-- one per fiscal year as lines, one per expense category; it is submitted
-- as an annual_budget request to the board and becomes active only when
-- approved (or rejected, or withdrawn with its request: final, a new draft
-- is drafted). A budget_increase the board approves adds to one line of the
-- active budget (append-only adjustments). The fiscal year starts on the
-- first of the compound's month (finance_settings), fixed once a budget was
-- submitted.
-- ============================================================================

ALTER TABLE "finance_settings" ADD COLUMN "fiscal_year_start_month" SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE "finance_settings" ADD CONSTRAINT "finance_settings_fiscal_year_start_month"
  CHECK ("fiscal_year_start_month" BETWEEN 1 AND 12);

CREATE TABLE "finance_budgets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fiscal_year" SMALLINT NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "approval_request_id" UUID,
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "submitted_at" TIMESTAMPTZ(3),
    "decided_at" TIMESTAMPTZ(3),
    CONSTRAINT "finance_budgets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_budgets_tenant_id_id_key" ON "finance_budgets"("tenant_id", "id");
-- One active budget per year, and one in the making (a draft or submitted).
CREATE UNIQUE INDEX "finance_budgets_one_active" ON "finance_budgets"("tenant_id", "fiscal_year")
  WHERE "status" = 'active';
CREATE UNIQUE INDEX "finance_budgets_one_in_progress" ON "finance_budgets"("tenant_id", "fiscal_year")
  WHERE "status" IN ('draft', 'submitted');
CREATE INDEX "finance_budgets_year_idx" ON "finance_budgets"("tenant_id", "fiscal_year", "created_at", "id");
ALTER TABLE "finance_budgets"
  ADD CONSTRAINT "finance_budgets_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_budgets_tenant_id_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- Deferred: the budget is submitted (in governance's raise) before its
  -- request row is written, in the same transaction.
  ADD CONSTRAINT "finance_budgets_tenant_id_request_id_fkey"
  FOREIGN KEY ("tenant_id", "approval_request_id") REFERENCES "governance_approval_requests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "finance_budgets" ADD CONSTRAINT "finance_budgets_period"
  CHECK ("fiscal_year" BETWEEN 2000 AND 2100
     AND extract(day FROM "starts_on") = 1
     AND "ends_on" = ("starts_on" + interval '1 year' - interval '1 day')::date);
-- The status and the columns that say it, set together.
ALTER TABLE "finance_budgets" ADD CONSTRAINT "finance_budgets_state_shape"
  CHECK ("status" IN ('draft', 'submitted', 'active', 'rejected', 'withdrawn')
     AND ("status" = 'draft') = ("submitted_at" IS NULL)
     AND ("submitted_at" IS NULL) = ("approval_request_id" IS NULL)
     AND ("status" IN ('active', 'rejected', 'withdrawn')) = ("decided_at" IS NOT NULL));

-- A budget keeps its year; it moves draft → submitted → active, rejected or
-- withdrawn, once each.
CREATE FUNCTION finance_budget_moves() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."fiscal_year" = OLD."fiscal_year"
     AND NEW."starts_on" = OLD."starts_on" AND NEW."ends_on" = OLD."ends_on"
     AND NEW."created_by_account_id" = OLD."created_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND (NEW."status" = OLD."status"
          OR (OLD."status" = 'draft' AND NEW."status" = 'submitted')
          OR (OLD."status" = 'submitted' AND NEW."status" IN ('active', 'rejected', 'withdrawn')))
     AND (NEW."approval_request_id" IS NOT DISTINCT FROM OLD."approval_request_id" OR OLD."approval_request_id" IS NULL)
     AND (NEW."submitted_at" IS NOT DISTINCT FROM OLD."submitted_at" OR OLD."submitted_at" IS NULL)
     AND (NEW."decided_at" IS NOT DISTINCT FROM OLD."decided_at" OR OLD."decided_at" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'finance_budgets: a budget keeps its year and moves forward once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER finance_budgets_moves
  BEFORE UPDATE OR DELETE ON "finance_budgets"
  FOR EACH ROW EXECUTE FUNCTION finance_budget_moves();
CREATE TRIGGER finance_budgets_moves_truncate
  BEFORE TRUNCATE ON "finance_budgets"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- A budget's lines: one per category, written only while it is a draft.
-- ----------------------------------------------------------------------------
CREATE TABLE "finance_budget_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "budget_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    CONSTRAINT "finance_budget_lines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_budget_lines_tenant_id_id_key" ON "finance_budget_lines"("tenant_id", "id");
CREATE UNIQUE INDEX "finance_budget_lines_category_key"
  ON "finance_budget_lines"("tenant_id", "budget_id", "category");
ALTER TABLE "finance_budget_lines"
  ADD CONSTRAINT "finance_budget_lines_tenant_id_budget_id_fkey"
  FOREIGN KEY ("tenant_id", "budget_id") REFERENCES "finance_budgets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- BUDGET_CATEGORIES; a unit test keeps them in step.
ALTER TABLE "finance_budget_lines" ADD CONSTRAINT "finance_budget_lines_category"
  CHECK ("category" IN ('security', 'cleaning', 'landscaping', 'maintenance', 'utilities',
                        'staff', 'insurance', 'administration', 'reserve_fund', 'other'));
ALTER TABLE "finance_budget_lines" ADD CONSTRAINT "finance_budget_lines_shape"
  CHECK ("amount" > 0 AND "amount" <= 999999999.99
     AND ("note" IS NULL OR char_length("note") BETWEEN 1 AND 200));

CREATE FUNCTION finance_budget_line_while_draft() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  b uuid;
  st text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    b := OLD."budget_id";
  ELSE
    b := NEW."budget_id";
    IF TG_OP = 'UPDATE' AND NEW."budget_id" <> OLD."budget_id" THEN
      RAISE EXCEPTION 'finance_budget_lines: a line keeps its budget'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  SELECT x."status" INTO st FROM "finance_budgets" x
   WHERE x."tenant_id" = COALESCE(NEW."tenant_id", OLD."tenant_id") AND x."id" = b;
  IF st IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'finance_budget_lines: a budget''s lines change only while it is a draft (%)', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
CREATE TRIGGER finance_budget_lines_while_draft
  BEFORE INSERT OR UPDATE OR DELETE ON "finance_budget_lines"
  FOR EACH ROW EXECUTE FUNCTION finance_budget_line_while_draft();
CREATE TRIGGER finance_budget_lines_truncate
  BEFORE TRUNCATE ON "finance_budget_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- An increase of one line, by the board's approval of a budget_increase:
-- once per request, append-only.
-- ----------------------------------------------------------------------------
CREATE TABLE "finance_budget_adjustments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "approval_request_id" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "finance_budget_adjustments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_budget_adjustments_request_key"
  ON "finance_budget_adjustments"("tenant_id", "approval_request_id");
CREATE INDEX "finance_budget_adjustments_line_idx" ON "finance_budget_adjustments"("tenant_id", "line_id");
ALTER TABLE "finance_budget_adjustments"
  ADD CONSTRAINT "finance_budget_adjustments_tenant_id_line_id_fkey"
  FOREIGN KEY ("tenant_id", "line_id") REFERENCES "finance_budget_lines"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_budget_adjustments_tenant_id_request_id_fkey"
  FOREIGN KEY ("tenant_id", "approval_request_id") REFERENCES "governance_approval_requests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_budget_adjustments" ADD CONSTRAINT "finance_budget_adjustments_amount"
  CHECK ("amount" > 0 AND "amount" <= 999999999.99);
CREATE TRIGGER finance_budget_adjustments_immutable_rows
  BEFORE UPDATE OR DELETE ON "finance_budget_adjustments"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER finance_budget_adjustments_immutable_truncate
  BEFORE TRUNCATE ON "finance_budget_adjustments"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "finance_budgets", "finance_budget_lines", "finance_budget_adjustments" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "finance_budgets" TO jiwar_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "finance_budget_lines" TO jiwar_app;
GRANT SELECT, INSERT ON "finance_budget_adjustments" TO jiwar_app;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_budgets', 'finance_budget_lines', 'finance_budget_adjustments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
