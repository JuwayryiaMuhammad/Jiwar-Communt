-- ============================================================================
-- Compound contracts (ADR 0077): the maintenance contracts of ADR 0065 take
-- every trade the compound contracts for, and the terms a contract is run
-- by. The table keeps its name.
--
-- - Kinds: cleaning, security, landscaping, pest control and supply join
--   the annual maintenance, service and extended-warranty contracts.
-- - Terms: a late penalty a day and its cap, the vendor's response hours,
--   and penalty terms in words; whether it renews by itself and for how
--   many months, which the end announcement says.
-- - A renewal is a new contract naming the one it renews (`renews_id`),
--   once: the old one keeps its dates.
-- - The board's approval it was signed under (a major contract, ADR 0055)
--   and the budget line it is paid from.
-- - A payment schedule: what is due on which day, paid once, with the
--   reference of what paid it. A due payment is announced once.
-- ============================================================================

ALTER TABLE "maintenance_contracts" DROP CONSTRAINT "maintenance_contracts_kind_known";
ALTER TABLE "maintenance_contracts" ADD CONSTRAINT "maintenance_contracts_kind_known"
  CHECK ("kind" IN ('amc', 'service', 'warranty_extension', 'cleaning', 'security',
                    'landscaping', 'pest_control', 'supply', 'other'));

ALTER TABLE "maintenance_contracts"
  ADD COLUMN "late_penalty_per_day" DECIMAL(12,2),
  ADD COLUMN "penalty_cap" DECIMAL(12,2),
  ADD COLUMN "response_hours" SMALLINT,
  ADD COLUMN "penalty_terms" TEXT,
  ADD COLUMN "auto_renews" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "renewal_term_months" SMALLINT,
  ADD COLUMN "renews_id" UUID,
  ADD COLUMN "approval_request_id" UUID,
  ADD COLUMN "budget_line_id" UUID;

ALTER TABLE "maintenance_contracts"
  ADD CONSTRAINT "maintenance_contracts_tenant_id_renews_fkey"
  FOREIGN KEY ("tenant_id", "renews_id") REFERENCES "maintenance_contracts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "maintenance_contracts_tenant_id_approval_fkey"
  FOREIGN KEY ("tenant_id", "approval_request_id") REFERENCES "governance_approval_requests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "maintenance_contracts_tenant_id_budget_line_fkey"
  FOREIGN KEY ("tenant_id", "budget_line_id") REFERENCES "finance_budget_lines"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- A contract is renewed once; an approval signs one contract.
CREATE UNIQUE INDEX "maintenance_contracts_renews_key"
  ON "maintenance_contracts"("tenant_id", "renews_id") WHERE "renews_id" IS NOT NULL;
CREATE UNIQUE INDEX "maintenance_contracts_approval_key"
  ON "maintenance_contracts"("tenant_id", "approval_request_id") WHERE "approval_request_id" IS NOT NULL;

ALTER TABLE "maintenance_contracts" ADD CONSTRAINT "maintenance_contracts_terms"
  CHECK (("late_penalty_per_day" IS NULL OR ("late_penalty_per_day" > 0 AND "late_penalty_per_day" < 10000000))
     AND ("penalty_cap" IS NULL OR ("penalty_cap" > 0 AND "penalty_cap" < 10000000000))
     AND ("penalty_cap" IS NULL OR "late_penalty_per_day" IS NOT NULL)
     AND ("response_hours" IS NULL OR "response_hours" BETWEEN 1 AND 720)
     AND ("penalty_terms" IS NULL OR char_length("penalty_terms") BETWEEN 1 AND 1000)
     AND ("renewal_term_months" IS NULL OR "renewal_term_months" BETWEEN 1 AND 60)
     AND (NOT "auto_renews" OR "renewal_term_months" IS NOT NULL)
     AND ("renews_id" IS NULL OR "renews_id" <> "id"));

-- What the renewal and the links are never change; a terminated contract
-- keeps its terms too (ADR 0065's trigger, now with them).
CREATE OR REPLACE FUNCTION "maintenance_contracts_terminated_once"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a contract is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."code" <> OLD."code" OR NEW."created_at" <> OLD."created_at"
     OR NEW."renews_id" IS DISTINCT FROM OLD."renews_id"
     OR (OLD."approval_request_id" IS NOT NULL
         AND NEW."approval_request_id" IS DISTINCT FROM OLD."approval_request_id")
     OR (OLD."terminated_at" IS NOT NULL AND (
          NEW."terminated_at" IS DISTINCT FROM OLD."terminated_at"
       OR NEW."termination_reason" IS DISTINCT FROM OLD."termination_reason"
       OR NEW."starts_on" <> OLD."starts_on" OR NEW."ends_on" <> OLD."ends_on"
       OR NEW."annual_value" IS DISTINCT FROM OLD."annual_value"
       OR NEW."kind" <> OLD."kind"
       OR NEW."vendor_id" <> OLD."vendor_id"
       OR NEW."late_penalty_per_day" IS DISTINCT FROM OLD."late_penalty_per_day"
       OR NEW."penalty_cap" IS DISTINCT FROM OLD."penalty_cap"
       OR NEW."response_hours" IS DISTINCT FROM OLD."response_hours"
       OR NEW."penalty_terms" IS DISTINCT FROM OLD."penalty_terms"
       OR NEW."auto_renews" <> OLD."auto_renews"
       OR NEW."renewal_term_months" IS DISTINCT FROM OLD."renewal_term_months"
       OR NEW."budget_line_id" IS DISTINCT FROM OLD."budget_line_id")) THEN
    RAISE EXCEPTION 'a terminated contract never changes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- The payment schedule.
-- ----------------------------------------------------------------------------
CREATE TABLE "maintenance_contract_payments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "due_on" DATE NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "paid_on" DATE,
    "paid_reference" TEXT,
    "paid_by_account_id" UUID,
    "paid_at" TIMESTAMPTZ(3),
    "due_alerted_at" TIMESTAMPTZ(3),
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "maintenance_contract_payments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "maintenance_contract_payments_tenant_id_id_key"
  ON "maintenance_contract_payments"("tenant_id", "id");
-- One payment a contract a day.
CREATE UNIQUE INDEX "maintenance_contract_payments_day_key"
  ON "maintenance_contract_payments"("tenant_id", "contract_id", "due_on");
-- What the due sweep reads, and next month's commitments.
CREATE INDEX "maintenance_contract_payments_due_idx"
  ON "maintenance_contract_payments"("tenant_id", "due_on", "id")
  WHERE "paid_at" IS NULL;
ALTER TABLE "maintenance_contract_payments"
  ADD CONSTRAINT "maintenance_contract_payments_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "maintenance_contract_payments_tenant_id_contract_fkey"
  FOREIGN KEY ("tenant_id", "contract_id") REFERENCES "maintenance_contracts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "maintenance_contract_payments_tenant_id_paid_by_fkey"
  FOREIGN KEY ("tenant_id", "paid_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "maintenance_contract_payments_tenant_id_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_contract_payments" ADD CONSTRAINT "maintenance_contract_payments_shape"
  CHECK ("amount" > 0 AND "amount" < 10000000000
     AND ("note" IS NULL OR char_length("note") BETWEEN 1 AND 200)
     AND ("paid_reference" IS NULL OR char_length("paid_reference") BETWEEN 1 AND 120)
     AND (("paid_at" IS NULL) = ("paid_on" IS NULL)
          AND ("paid_at" IS NULL) = ("paid_by_account_id" IS NULL)));

-- A payment is paid once and then never changes; an unpaid one may be
-- removed (the schedule replaced) or moved, never its contract.
CREATE FUNCTION maintenance_contract_payments_paid_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD."paid_at" IS NULL THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."contract_id" = OLD."contract_id"
     AND NEW."created_by_account_id" = OLD."created_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND (OLD."paid_at" IS NULL
          OR (NEW."due_on" = OLD."due_on" AND NEW."amount" = OLD."amount"
              AND NEW."note" IS NOT DISTINCT FROM OLD."note"
              AND NEW."paid_on" = OLD."paid_on"
              AND NEW."paid_reference" IS NOT DISTINCT FROM OLD."paid_reference"
              AND NEW."paid_by_account_id" = OLD."paid_by_account_id"
              AND NEW."paid_at" = OLD."paid_at")) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'maintenance_contract_payments: a payment is paid once and then kept (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER maintenance_contract_payments_paid_once
  BEFORE UPDATE OR DELETE ON "maintenance_contract_payments"
  FOR EACH ROW EXECUTE FUNCTION maintenance_contract_payments_paid_once();
CREATE TRIGGER maintenance_contract_payments_paid_once_truncate
  BEFORE TRUNCATE ON "maintenance_contract_payments"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "maintenance_contract_payments" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "maintenance_contract_payments" TO jiwar_app;
ALTER TABLE "maintenance_contract_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "maintenance_contract_payments" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "maintenance_contract_payments"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
