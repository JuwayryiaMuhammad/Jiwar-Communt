-- ============================================================================
-- Finance (ADR 0055): what the compound spends, against a line of the
-- active budget. An expense names its vendor, amount, day, the invoice's
-- photo or PDF and a reference; it never takes the line past what the line
-- allows (its amount and approved increases, less live expenses), and one
-- above the manager's limit (major_contract's threshold) names an expense
-- authorization: the board's approval of a major contract, spent down by
-- the expenses that name it. Expenses are voided once, never changed.
-- Numbered EX- in the compound's finance counters.
-- ============================================================================

ALTER TABLE "finance_counters" DROP CONSTRAINT "finance_counters_kind";
ALTER TABLE "finance_counters" ADD CONSTRAINT "finance_counters_kind"
  CHECK ("kind" IN ('invoice', 'credit_note', 'receipt', 'instalment_plan', 'refund', 'expense'));

CREATE TABLE "finance_expense_authorizations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "approval_request_id" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "finance_expense_authorizations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_expense_authorizations_tenant_id_id_key"
  ON "finance_expense_authorizations"("tenant_id", "id");
CREATE UNIQUE INDEX "finance_expense_authorizations_request_key"
  ON "finance_expense_authorizations"("tenant_id", "approval_request_id");
ALTER TABLE "finance_expense_authorizations"
  ADD CONSTRAINT "finance_expense_authorizations_tenant_id_request_id_fkey"
  FOREIGN KEY ("tenant_id", "approval_request_id") REFERENCES "governance_approval_requests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_expense_authorizations" ADD CONSTRAINT "finance_expense_authorizations_amount"
  CHECK ("amount" > 0 AND "amount" <= 999999999.99);
CREATE TRIGGER finance_expense_authorizations_immutable_rows
  BEFORE UPDATE OR DELETE ON "finance_expense_authorizations"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER finance_expense_authorizations_immutable_truncate
  BEFORE TRUNCATE ON "finance_expense_authorizations"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

CREATE TABLE "finance_expenses" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "budget_line_id" UUID NOT NULL,
    "authorization_id" UUID,
    "vendor" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "spent_on" DATE NOT NULL,
    "invoice_file_id" UUID NOT NULL,
    "reference" TEXT,
    "recorded_by_account_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,
    "voided_at" TIMESTAMPTZ(3),
    "voided_by_account_id" UUID,
    "void_reason_code" TEXT,
    CONSTRAINT "finance_expenses_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_expenses_tenant_id_id_key" ON "finance_expenses"("tenant_id", "id");
CREATE UNIQUE INDEX "finance_expenses_number_key" ON "finance_expenses"("tenant_id", "number");
CREATE UNIQUE INDEX "finance_expenses_invoice_file_key" ON "finance_expenses"("tenant_id", "invoice_file_id");
CREATE INDEX "finance_expenses_line_idx" ON "finance_expenses"("tenant_id", "budget_line_id", "spent_on", "id");
CREATE INDEX "finance_expenses_authorization_idx" ON "finance_expenses"("tenant_id", "authorization_id")
  WHERE "authorization_id" IS NOT NULL;
CREATE INDEX "finance_expenses_recorded_idx" ON "finance_expenses"("tenant_id", "recorded_at", "id");
ALTER TABLE "finance_expenses"
  ADD CONSTRAINT "finance_expenses_tenant_id_line_id_fkey"
  FOREIGN KEY ("tenant_id", "budget_line_id") REFERENCES "finance_budget_lines"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_expenses_tenant_id_authorization_id_fkey"
  FOREIGN KEY ("tenant_id", "authorization_id") REFERENCES "finance_expense_authorizations"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_expenses_tenant_id_invoice_file_id_fkey"
  FOREIGN KEY ("tenant_id", "invoice_file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_expenses_tenant_id_recorded_by_fkey"
  FOREIGN KEY ("tenant_id", "recorded_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_expenses_tenant_id_voided_by_fkey"
  FOREIGN KEY ("tenant_id", "voided_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_expenses" ADD CONSTRAINT "finance_expenses_shape"
  CHECK ("number" >= 1
     AND "amount" > 0 AND "amount" <= 999999999.99
     AND char_length("vendor") BETWEEN 1 AND 200
     AND ("reference" IS NULL OR char_length("reference") BETWEEN 1 AND 100));
ALTER TABLE "finance_expenses" ADD CONSTRAINT "finance_expenses_void_shape"
  CHECK (("voided_at" IS NULL) = ("voided_by_account_id" IS NULL)
     AND ("voided_at" IS NULL) = ("void_reason_code" IS NULL));
-- REASON_CODES.expenseVoid; a unit test keeps the two in step.
ALTER TABLE "finance_expenses" ADD CONSTRAINT "finance_expenses_void_reason"
  CHECK ("void_reason_code" IS NULL
      OR "void_reason_code" IN ('entered_in_error', 'duplicate', 'vendor_refund', 'other'));

-- An expense keeps its terms and is voided once.
CREATE FUNCTION finance_expense_moves() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number"
     AND NEW."budget_line_id" = OLD."budget_line_id"
     AND NEW."authorization_id" IS NOT DISTINCT FROM OLD."authorization_id"
     AND NEW."vendor" = OLD."vendor" AND NEW."amount" = OLD."amount"
     AND NEW."spent_on" = OLD."spent_on"
     AND NEW."invoice_file_id" = OLD."invoice_file_id"
     AND NEW."reference" IS NOT DISTINCT FROM OLD."reference"
     AND NEW."recorded_by_account_id" = OLD."recorded_by_account_id"
     AND NEW."recorded_at" = OLD."recorded_at"
     AND OLD."voided_at" IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'finance_expenses: an expense keeps its terms and is voided once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER finance_expenses_moves
  BEFORE UPDATE OR DELETE ON "finance_expenses"
  FOR EACH ROW EXECUTE FUNCTION finance_expense_moves();
CREATE TRIGGER finance_expenses_moves_truncate
  BEFORE TRUNCATE ON "finance_expenses"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "finance_expense_authorizations", "finance_expenses" FROM jiwar_app;
-- UPDATE only so an expense can lock the authorization (FOR UPDATE needs
-- it): its trigger refuses any change.
GRANT SELECT, INSERT, UPDATE ON "finance_expense_authorizations" TO jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "finance_expenses" TO jiwar_app;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_expense_authorizations', 'finance_expenses'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
