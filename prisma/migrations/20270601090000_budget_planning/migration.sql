-- ============================================================================
-- Budget planning (ADR 0089): money moved between two lines of a budget,
-- the yearly line split by month (a quarter is its three months), and why a
-- line ran past its plan in a month.
--
-- - A transfer within the manager's limit (the major contract threshold,
--   ADR 0055) is applied at once; above it, it waits for the board as a
--   `budget_transfer` request naming it, and the board's approval applies
--   it. Its terms never change; it moves forward only. An applied transfer
--   is what moves the lines' allowances: read, never stored.
-- - A line's months add up to its amount (checked at commit); replaced
--   whole, never on a rejected or withdrawn budget.
-- - A variance's reason, append-only: the latest of a line's month shows.
-- - `variance_reason_pct`: past this share of a month's plan, the period
--   report asks for a reason; null, never.
-- ============================================================================

ALTER TABLE "finance_settings" ADD COLUMN "variance_reason_pct" SMALLINT;
ALTER TABLE "finance_settings" ADD CONSTRAINT "finance_settings_variance_reason_pct"
  CHECK ("variance_reason_pct" IS NULL OR "variance_reason_pct" BETWEEN 1 AND 100);

-- The board approves a transfer above the manager's limit: the type, its
-- subject (the transfer) and a deadline for every compound. The CHECKs are
-- recreated with every type on main (ADR 0082's compensation_above_limit,
-- ADR 0075's manager_handover_override, 20270518090610 the last before this),
-- so a fresh database and an existing one both end with all of them.
ALTER TABLE "governance_approval_requests" DROP CONSTRAINT "governance_approval_requests_type";
ALTER TABLE "governance_approval_requests" ADD CONSTRAINT "governance_approval_requests_type"
  CHECK ("type" IN ('annual_budget', 'budget_increase', 'major_contract', 'exceptional_fee',
                    'waiver_above_limit', 'payment_plan_above_limit', 'legal_escalation',
                    'compensation_above_limit', 'manager_handover_override', 'budget_transfer'));
ALTER TABLE "governance_approval_requests" DROP CONSTRAINT "governance_approval_requests_subject";
ALTER TABLE "governance_approval_requests" ADD CONSTRAINT "governance_approval_requests_subject"
  CHECK (("subject_id" IS NOT NULL) = ("type" IN ('annual_budget', 'budget_increase', 'manager_handover_override',
                                                'budget_transfer')));
ALTER TABLE "governance_approval_settings" DROP CONSTRAINT "governance_approval_settings_type";
ALTER TABLE "governance_approval_settings" ADD CONSTRAINT "governance_approval_settings_type"
  CHECK ("type" IN ('annual_budget', 'budget_increase', 'major_contract', 'exceptional_fee',
                    'waiver_above_limit', 'payment_plan_above_limit', 'legal_escalation',
                    'compensation_above_limit', 'manager_handover_override', 'budget_transfer',
                    'board_appeal', 'objection'));
-- FORCE RLS applies to the migrator too: one compound at a time.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    INSERT INTO "governance_approval_settings" ("tenant_id", "type", "deadline_days")
      VALUES (t."id", 'budget_transfer', 14)
      ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

-- ----------------------------------------------------------------------------
-- Transfers between two lines of one budget.
-- ----------------------------------------------------------------------------
CREATE TABLE "finance_budget_transfers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "budget_id" UUID NOT NULL,
    "from_line_id" UUID NOT NULL,
    "to_line_id" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "requested_by_account_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL,
    "approval_request_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    CONSTRAINT "finance_budget_transfers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_budget_transfers_tenant_id_id_key" ON "finance_budget_transfers"("tenant_id", "id");
-- A board request names one transfer.
CREATE UNIQUE INDEX "finance_budget_transfers_approval_key"
  ON "finance_budget_transfers"("tenant_id", "approval_request_id") WHERE "approval_request_id" IS NOT NULL;
CREATE INDEX "finance_budget_transfers_budget_idx"
  ON "finance_budget_transfers"("tenant_id", "budget_id", "requested_at" DESC, "id" DESC);
-- What a line's figures read: the applied transfers in and out of it.
CREATE INDEX "finance_budget_transfers_from_idx"
  ON "finance_budget_transfers"("tenant_id", "from_line_id") WHERE "status" = 'applied';
CREATE INDEX "finance_budget_transfers_to_idx"
  ON "finance_budget_transfers"("tenant_id", "to_line_id") WHERE "status" = 'applied';
ALTER TABLE "finance_budget_transfers"
  ADD CONSTRAINT "finance_budget_transfers_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_budget_transfers_budget_fkey"
  FOREIGN KEY ("tenant_id", "budget_id") REFERENCES "finance_budgets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_budget_transfers_from_fkey"
  FOREIGN KEY ("tenant_id", "from_line_id") REFERENCES "finance_budget_lines"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_budget_transfers_to_fkey"
  FOREIGN KEY ("tenant_id", "to_line_id") REFERENCES "finance_budget_lines"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_budget_transfers_requested_by_fkey"
  FOREIGN KEY ("tenant_id", "requested_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_budget_transfers_approval_fkey"
  FOREIGN KEY ("tenant_id", "approval_request_id") REFERENCES "governance_approval_requests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_budget_transfers" ADD CONSTRAINT "finance_budget_transfers_shape"
  CHECK ("from_line_id" <> "to_line_id"
     AND "amount" > 0 AND "amount" <= 999999999.99
     AND char_length("reason") BETWEEN 1 AND 500);
-- Applied at once or by the board; waiting for the board, it is raised once
-- (a request named) and decided, or called off before.
ALTER TABLE "finance_budget_transfers" ADD CONSTRAINT "finance_budget_transfers_state_shape"
  CHECK ("status" IN ('awaiting_board', 'applied', 'rejected', 'withdrawn', 'lapsed')
     AND (("status" = 'awaiting_board') = ("decided_at" IS NULL))
     AND ("status" NOT IN ('rejected', 'lapsed') OR "approval_request_id" IS NOT NULL));

-- Terms fixed; a request named once; forward only.
CREATE FUNCTION finance_budget_transfers_move_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."budget_id" = OLD."budget_id"
     AND NEW."from_line_id" = OLD."from_line_id"
     AND NEW."to_line_id" = OLD."to_line_id"
     AND NEW."amount" = OLD."amount"
     AND NEW."reason" = OLD."reason"
     AND NEW."requested_by_account_id" = OLD."requested_by_account_id"
     AND NEW."requested_at" = OLD."requested_at"
     AND OLD."status" = 'awaiting_board'
     AND (OLD."approval_request_id" IS NULL
          OR NEW."approval_request_id" IS NOT DISTINCT FROM OLD."approval_request_id") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'finance_budget_transfers: a transfer keeps its terms and moves forward once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER finance_budget_transfers_move_forward
  BEFORE UPDATE OR DELETE ON "finance_budget_transfers"
  FOR EACH ROW EXECUTE FUNCTION finance_budget_transfers_move_forward();
CREATE TRIGGER finance_budget_transfers_truncate
  BEFORE TRUNCATE ON "finance_budget_transfers"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- A line's months (1 is the fiscal year's first).
-- ----------------------------------------------------------------------------
CREATE TABLE "finance_budget_line_months" (
    "tenant_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "month" SMALLINT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    CONSTRAINT "finance_budget_line_months_pkey" PRIMARY KEY ("tenant_id", "line_id", "month")
);
ALTER TABLE "finance_budget_line_months"
  ADD CONSTRAINT "finance_budget_line_months_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_budget_line_months_line_fkey"
  FOREIGN KEY ("tenant_id", "line_id") REFERENCES "finance_budget_lines"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_budget_line_months" ADD CONSTRAINT "finance_budget_line_months_shape"
  CHECK ("month" BETWEEN 1 AND 12 AND "amount" >= 0 AND "amount" <= 999999999.99);

-- At commit, a line split by month is split whole: twelve months adding up
-- to its amount (a line with no month is split evenly when read).
CREATE FUNCTION finance_budget_line_months_whole() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  l uuid := COALESCE(NEW."line_id", OLD."line_id");
  n integer;
  total numeric;
  want numeric;
BEGIN
  SELECT count(*), COALESCE(sum("amount"), 0) INTO n, total
    FROM "finance_budget_line_months" WHERE "line_id" = l;
  IF n = 0 THEN
    RETURN NULL;
  END IF;
  SELECT "amount" INTO want FROM "finance_budget_lines" WHERE "id" = l;
  IF n <> 12 OR total <> want THEN
    RAISE EXCEPTION 'line %: its twelve months add up to its amount', l
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER finance_budget_line_months_whole
  AFTER INSERT OR UPDATE OR DELETE ON "finance_budget_line_months" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance_budget_line_months_whole();
CREATE TRIGGER finance_budget_line_months_truncate
  BEFORE TRUNCATE ON "finance_budget_line_months"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Why a line ran past its plan in a month. Append-only.
-- ----------------------------------------------------------------------------
CREATE TABLE "finance_budget_variance_notes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "month" SMALLINT NOT NULL,
    "reason_code" TEXT NOT NULL,
    "note" TEXT,
    "recorded_by_account_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "finance_budget_variance_notes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_budget_variance_notes_tenant_id_id_key"
  ON "finance_budget_variance_notes"("tenant_id", "id");
CREATE INDEX "finance_budget_variance_notes_line_idx"
  ON "finance_budget_variance_notes"("tenant_id", "line_id", "month", "recorded_at" DESC);
ALTER TABLE "finance_budget_variance_notes"
  ADD CONSTRAINT "finance_budget_variance_notes_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_budget_variance_notes_line_fkey"
  FOREIGN KEY ("tenant_id", "line_id") REFERENCES "finance_budget_lines"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_budget_variance_notes_recorded_by_fkey"
  FOREIGN KEY ("tenant_id", "recorded_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- REASON_CODES.budgetVariance; a unit test keeps the two in step.
ALTER TABLE "finance_budget_variance_notes" ADD CONSTRAINT "finance_budget_variance_notes_shape"
  CHECK ("month" BETWEEN 1 AND 12
     AND "reason_code" IN ('timing', 'price_change', 'unplanned_work', 'saving', 'scope_change',
                           'emergency', 'other')
     AND ("note" IS NULL OR char_length("note") BETWEEN 1 AND 500));
CREATE TRIGGER finance_budget_variance_notes_immutable_rows
  BEFORE UPDATE OR DELETE ON "finance_budget_variance_notes"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER finance_budget_variance_notes_immutable_truncate
  BEFORE TRUNCATE ON "finance_budget_variance_notes"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "finance_budget_transfers", "finance_budget_line_months", "finance_budget_variance_notes" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "finance_budget_transfers" TO jiwar_app;
GRANT SELECT, INSERT, DELETE ON "finance_budget_line_months" TO jiwar_app;
GRANT SELECT, INSERT ON "finance_budget_variance_notes" TO jiwar_app;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_budget_transfers', 'finance_budget_line_months',
                           'finance_budget_variance_notes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
