-- ============================================================================
-- Paying vendors (ADR 0089): advances, retentions and guarantees on a
-- contract, and the payouts.
--
-- - A contract may hold back a share of each payout (`retention_pct`, up
--   to 20 %), released at its end with approval.
-- - An advance or a retention's release is asked for by one person and
--   approved by another (VD- numbers); approved, it is paid once.
-- - A payout (VP- numbers) is money out to a vendor, append-only, once per
--   invoice, advance or release: an invoice's payout writes its expense
--   (ADR 0055) and may hold back the contract's retention and set off its
--   open advances; what is paid is the rest. How it was paid is words for
--   now (a method and a reference): the treasury's accounts (ADR 0085) give
--   it the account it moved through when the two phases meet.
-- - A guarantee the vendor's bank gives on a contract: kept, returned or
--   called once; its expiry announced 30 days ahead, once.
-- ============================================================================

ALTER TABLE "maintenance_contracts" ADD COLUMN "retention_pct" DECIMAL(5,2);
ALTER TABLE "maintenance_contracts" ADD CONSTRAINT "maintenance_contracts_retention"
  CHECK ("retention_pct" IS NULL OR ("retention_pct" > 0 AND "retention_pct" <= 20));

-- ADR 0077's trigger, recreated whole: a terminated contract keeps its
-- retention too.
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
       OR NEW."budget_line_id" IS DISTINCT FROM OLD."budget_line_id"
       OR NEW."retention_pct" IS DISTINCT FROM OLD."retention_pct")) THEN
    RAISE EXCEPTION 'a terminated contract never changes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- Advances and retention releases on a contract.
-- ----------------------------------------------------------------------------
CREATE TABLE "finance_contract_disbursements" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "contract_id" UUID NOT NULL,
    "vendor_id" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "requested_by_account_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL,
    "decided_by_account_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "reject_reason" TEXT,
    "cancelled_by_account_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "paid_at" TIMESTAMPTZ(3),
    CONSTRAINT "finance_contract_disbursements_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_contract_disbursements_tenant_id_id_key"
  ON "finance_contract_disbursements"("tenant_id", "id");
CREATE UNIQUE INDEX "finance_contract_disbursements_number_key"
  ON "finance_contract_disbursements"("tenant_id", "number");
CREATE INDEX "finance_contract_disbursements_contract_idx"
  ON "finance_contract_disbursements"("tenant_id", "contract_id", "requested_at" DESC, "id" DESC);
CREATE INDEX "finance_contract_disbursements_status_idx"
  ON "finance_contract_disbursements"("tenant_id", "status", "requested_at", "id");
ALTER TABLE "finance_contract_disbursements"
  ADD CONSTRAINT "finance_contract_disbursements_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_contract_disbursements_contract_fkey"
  FOREIGN KEY ("tenant_id", "contract_id") REFERENCES "maintenance_contracts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_contract_disbursements_vendor_fkey"
  FOREIGN KEY ("tenant_id", "vendor_id") REFERENCES "vendors"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_contract_disbursements_requested_by_fkey"
  FOREIGN KEY ("tenant_id", "requested_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_contract_disbursements_decided_by_fkey"
  FOREIGN KEY ("tenant_id", "decided_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_contract_disbursements_cancelled_by_fkey"
  FOREIGN KEY ("tenant_id", "cancelled_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_contract_disbursements" ADD CONSTRAINT "finance_contract_disbursements_shape"
  CHECK ("number" > 0
     AND "kind" IN ('advance', 'retention_release')
     AND "amount" > 0 AND "amount" <= 999999999.99
     AND ("note" IS NULL OR char_length("note") BETWEEN 1 AND 500));
-- Nobody approves what they asked for (a CHECK too). REASON_CODES
-- .disbursementReject and .disbursementCancel; a unit test keeps them in step.
ALTER TABLE "finance_contract_disbursements" ADD CONSTRAINT "finance_contract_disbursements_state_shape"
  CHECK ("status" IN ('requested', 'approved', 'rejected', 'cancelled', 'paid')
     AND (("decided_at" IS NULL) = ("decided_by_account_id" IS NULL))
     AND ("decided_by_account_id" IS NULL OR "decided_by_account_id" <> "requested_by_account_id")
     AND ("status" NOT IN ('approved', 'rejected', 'paid') OR "decided_at" IS NOT NULL)
     AND ("status" <> 'requested' OR "decided_at" IS NULL)
     AND (("status" = 'rejected') = ("reject_reason" IS NOT NULL))
     AND ("reject_reason" IS NULL OR "reject_reason" IN ('not_due', 'too_much', 'not_agreed', 'other'))
     AND (("status" = 'cancelled') = ("cancelled_at" IS NOT NULL))
     AND (("cancelled_at" IS NULL) = ("cancelled_by_account_id" IS NULL))
     AND (("cancelled_at" IS NULL) = ("cancel_reason" IS NULL))
     AND ("cancel_reason" IS NULL OR "cancel_reason" IN ('entered_in_error', 'not_needed', 'other'))
     AND (("status" = 'paid') = ("paid_at" IS NOT NULL)));

CREATE FUNCTION finance_contract_disbursements_move_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number" AND NEW."kind" = OLD."kind"
     AND NEW."contract_id" = OLD."contract_id" AND NEW."vendor_id" = OLD."vendor_id"
     AND NEW."amount" = OLD."amount"
     AND NEW."note" IS NOT DISTINCT FROM OLD."note"
     AND NEW."requested_by_account_id" = OLD."requested_by_account_id"
     AND NEW."requested_at" = OLD."requested_at"
     AND ((OLD."status" = 'requested' AND NEW."status" IN ('approved', 'rejected', 'cancelled'))
       OR (OLD."status" = 'approved' AND NEW."status" IN ('paid', 'cancelled')
           AND NEW."decided_at" = OLD."decided_at"
           AND NEW."decided_by_account_id" = OLD."decided_by_account_id")) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'finance_contract_disbursements: a request keeps its terms and moves forward only (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER finance_contract_disbursements_move_forward
  BEFORE UPDATE OR DELETE ON "finance_contract_disbursements"
  FOR EACH ROW EXECUTE FUNCTION finance_contract_disbursements_move_forward();
CREATE TRIGGER finance_contract_disbursements_truncate
  BEFORE TRUNCATE ON "finance_contract_disbursements"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Payouts. Append-only.
-- ----------------------------------------------------------------------------
CREATE TABLE "finance_vendor_payouts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "vendor_invoice_id" UUID,
    "disbursement_id" UUID,
    "contract_id" UUID,
    "vendor_id" UUID NOT NULL,
    "expense_id" UUID,
    "gross" DECIMAL(14,2) NOT NULL,
    "retention_held" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "advance_set_off" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "net" DECIMAL(14,2) NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "paid_on" DATE NOT NULL,
    "paid_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "finance_vendor_payouts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_vendor_payouts_tenant_id_id_key" ON "finance_vendor_payouts"("tenant_id", "id");
CREATE UNIQUE INDEX "finance_vendor_payouts_number_key" ON "finance_vendor_payouts"("tenant_id", "number");
-- Each invoice, advance or release is paid once, and an expense pays one.
CREATE UNIQUE INDEX "finance_vendor_payouts_invoice_key"
  ON "finance_vendor_payouts"("tenant_id", "vendor_invoice_id") WHERE "vendor_invoice_id" IS NOT NULL;
CREATE UNIQUE INDEX "finance_vendor_payouts_disbursement_key"
  ON "finance_vendor_payouts"("tenant_id", "disbursement_id") WHERE "disbursement_id" IS NOT NULL;
CREATE UNIQUE INDEX "finance_vendor_payouts_expense_key"
  ON "finance_vendor_payouts"("tenant_id", "expense_id") WHERE "expense_id" IS NOT NULL;
CREATE INDEX "finance_vendor_payouts_contract_idx"
  ON "finance_vendor_payouts"("tenant_id", "contract_id") WHERE "contract_id" IS NOT NULL;
CREATE INDEX "finance_vendor_payouts_paid_idx"
  ON "finance_vendor_payouts"("tenant_id", "paid_on", "id");
ALTER TABLE "finance_vendor_payouts"
  ADD CONSTRAINT "finance_vendor_payouts_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_vendor_payouts_invoice_fkey"
  FOREIGN KEY ("tenant_id", "vendor_invoice_id") REFERENCES "finance_vendor_invoices"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_vendor_payouts_disbursement_fkey"
  FOREIGN KEY ("tenant_id", "disbursement_id") REFERENCES "finance_contract_disbursements"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_vendor_payouts_contract_fkey"
  FOREIGN KEY ("tenant_id", "contract_id") REFERENCES "maintenance_contracts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_vendor_payouts_vendor_fkey"
  FOREIGN KEY ("tenant_id", "vendor_id") REFERENCES "vendors"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_vendor_payouts_expense_fkey"
  FOREIGN KEY ("tenant_id", "expense_id") REFERENCES "finance_expenses"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_vendor_payouts_paid_by_fkey"
  FOREIGN KEY ("tenant_id", "paid_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- An invoice's payout writes its expense and may hold back and set off;
-- an advance's or a release's is paid whole. What is paid is the rest.
ALTER TABLE "finance_vendor_payouts" ADD CONSTRAINT "finance_vendor_payouts_shape"
  CHECK ("number" > 0
     AND "kind" IN ('invoice', 'advance', 'retention_release')
     AND (("kind" = 'invoice') = ("vendor_invoice_id" IS NOT NULL))
     AND (("kind" = 'invoice') = ("expense_id" IS NOT NULL))
     AND (("kind" = 'invoice') = ("disbursement_id" IS NULL))
     AND ("kind" <> 'invoice' OR "contract_id" IS NOT NULL OR ("retention_held" = 0 AND "advance_set_off" = 0))
     AND ("kind" = 'invoice' OR ("contract_id" IS NOT NULL AND "retention_held" = 0 AND "advance_set_off" = 0))
     AND "gross" > 0 AND "gross" <= 999999999.99
     AND "retention_held" >= 0 AND "advance_set_off" >= 0
     AND "net" >= 0 AND "net" = "gross" - "retention_held" - "advance_set_off"
     AND "method" IN ('bank_transfer', 'cheque', 'cash')
     AND ("reference" IS NULL OR char_length("reference") BETWEEN 1 AND 100));
CREATE TRIGGER finance_vendor_payouts_immutable_rows
  BEFORE UPDATE OR DELETE ON "finance_vendor_payouts"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER finance_vendor_payouts_immutable_truncate
  BEFORE TRUNCATE ON "finance_vendor_payouts"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Guarantees on a contract.
-- ----------------------------------------------------------------------------
CREATE TABLE "finance_vendor_guarantees" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "vendor_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "issued_on" DATE NOT NULL,
    "expires_on" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'held',
    "recorded_by_account_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_by_account_id" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "expiry_alerted_at" TIMESTAMPTZ(3),
    CONSTRAINT "finance_vendor_guarantees_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_vendor_guarantees_tenant_id_id_key"
  ON "finance_vendor_guarantees"("tenant_id", "id");
CREATE INDEX "finance_vendor_guarantees_contract_idx"
  ON "finance_vendor_guarantees"("tenant_id", "contract_id", "expires_on");
-- What the expiry sweep reads.
CREATE INDEX "finance_vendor_guarantees_expiry_idx"
  ON "finance_vendor_guarantees"("tenant_id", "expires_on", "id")
  WHERE "status" = 'held' AND "expiry_alerted_at" IS NULL;
ALTER TABLE "finance_vendor_guarantees"
  ADD CONSTRAINT "finance_vendor_guarantees_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_vendor_guarantees_contract_fkey"
  FOREIGN KEY ("tenant_id", "contract_id") REFERENCES "maintenance_contracts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_vendor_guarantees_vendor_fkey"
  FOREIGN KEY ("tenant_id", "vendor_id") REFERENCES "vendors"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_vendor_guarantees_recorded_by_fkey"
  FOREIGN KEY ("tenant_id", "recorded_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_vendor_guarantees_closed_by_fkey"
  FOREIGN KEY ("tenant_id", "closed_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_vendor_guarantees" ADD CONSTRAINT "finance_vendor_guarantees_shape"
  CHECK ("kind" IN ('performance', 'advance_payment', 'warranty', 'other')
     AND char_length("issuer") BETWEEN 1 AND 120
     AND char_length("reference") BETWEEN 1 AND 60
     AND "amount" > 0 AND "amount" <= 999999999.99
     AND "issued_on" <= "expires_on"
     AND "status" IN ('held', 'returned', 'called')
     AND (("status" = 'held') = ("closed_at" IS NULL))
     AND (("closed_at" IS NULL) = ("closed_by_account_id" IS NULL)));

-- Terms fixed; returned or called once; its expiry told once.
CREATE FUNCTION finance_vendor_guarantees_close_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."contract_id" = OLD."contract_id" AND NEW."vendor_id" = OLD."vendor_id"
     AND NEW."kind" = OLD."kind" AND NEW."issuer" = OLD."issuer"
     AND NEW."reference" = OLD."reference" AND NEW."amount" = OLD."amount"
     AND NEW."issued_on" = OLD."issued_on" AND NEW."expires_on" = OLD."expires_on"
     AND NEW."recorded_by_account_id" = OLD."recorded_by_account_id"
     AND NEW."recorded_at" = OLD."recorded_at"
     AND (OLD."expiry_alerted_at" IS NULL
          OR NEW."expiry_alerted_at" IS NOT DISTINCT FROM OLD."expiry_alerted_at")
     AND (NEW."status" = OLD."status"
          OR (OLD."status" = 'held' AND NEW."status" IN ('returned', 'called')))
     AND (OLD."status" = 'held'
          OR (NEW."closed_at" IS NOT DISTINCT FROM OLD."closed_at"
              AND NEW."closed_by_account_id" IS NOT DISTINCT FROM OLD."closed_by_account_id")) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'finance_vendor_guarantees: a guarantee keeps its terms and closes once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER finance_vendor_guarantees_close_once
  BEFORE UPDATE OR DELETE ON "finance_vendor_guarantees"
  FOR EACH ROW EXECUTE FUNCTION finance_vendor_guarantees_close_once();
CREATE TRIGGER finance_vendor_guarantees_truncate
  BEFORE TRUNCATE ON "finance_vendor_guarantees"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "finance_contract_disbursements", "finance_vendor_payouts", "finance_vendor_guarantees" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "finance_contract_disbursements" TO jiwar_app;
GRANT SELECT, INSERT ON "finance_vendor_payouts" TO jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "finance_vendor_guarantees" TO jiwar_app;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_contract_disbursements', 'finance_vendor_payouts',
                           'finance_vendor_guarantees'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
