-- ============================================================================
-- Vendors' invoices (ADR 0089): what a vendor of the register (ADR 0077)
-- bills the compound, against one of its contracts, a line of that
-- contract's payment schedule, or a purchase request it fulfilled, with
-- the invoice's scan (an `expense_invoice` file, ADR 0055) and its lines.
--
-- - A VI- number a compound; the vendor's own number, once per vendor among
--   the live invoices (whatever its case), and one live invoice a payment.
-- - Received by the office (`channel`; the contractor portal, ADR 0088,
--   adds its own), approved against a line of the active budget by someone
--   who did not record it, under the manager's limit or the board's
--   approved major contract (its authorization, ADR 0055), turned down or
--   called off; approved, it is paid once, which writes its expense.
-- - Each line has a tax code, zero by default; the lines add up to the
--   invoice's subtotal and tax (checked at commit). Amounts as DECIMAL, as
--   the repo stores money (ADR 0046).
-- - An expense names the invoice it pays, once; such an expense is never
--   voided (its trigger is recreated whole).
-- ============================================================================

ALTER TABLE "finance_counters" DROP CONSTRAINT "finance_counters_kind";
ALTER TABLE "finance_counters" ADD CONSTRAINT "finance_counters_kind"
  CHECK ("kind" IN ('invoice', 'credit_note', 'receipt', 'instalment_plan', 'refund', 'expense',
                    'clearance', 'deposit', 'vendor_invoice', 'disbursement', 'payout'));

CREATE TABLE "finance_vendor_invoices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'office',
    "vendor_id" UUID NOT NULL,
    "vendor_number" TEXT NOT NULL,
    "issued_on" DATE NOT NULL,
    "due_on" DATE NOT NULL,
    "contract_id" UUID,
    "contract_payment_id" UUID,
    "purchase_request_id" UUID,
    "budget_line_id" UUID,
    "authorization_id" UUID,
    "invoice_file_id" UUID NOT NULL,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "tax" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'received',
    "recorded_by_account_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,
    "decided_by_account_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "reject_reason" TEXT,
    "cancelled_by_account_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "paid_at" TIMESTAMPTZ(3),
    CONSTRAINT "finance_vendor_invoices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_vendor_invoices_tenant_id_id_key" ON "finance_vendor_invoices"("tenant_id", "id");
CREATE UNIQUE INDEX "finance_vendor_invoices_number_key" ON "finance_vendor_invoices"("tenant_id", "number");
CREATE UNIQUE INDEX "finance_vendor_invoices_file_key" ON "finance_vendor_invoices"("tenant_id", "invoice_file_id");
-- A vendor's number once among the live invoices, whatever its case.
CREATE UNIQUE INDEX "finance_vendor_invoices_vendor_number_key"
  ON "finance_vendor_invoices"("tenant_id", "vendor_id", lower("vendor_number"))
  WHERE "status" IN ('received', 'approved', 'paid');
-- One live invoice a contract payment.
CREATE UNIQUE INDEX "finance_vendor_invoices_payment_key"
  ON "finance_vendor_invoices"("tenant_id", "contract_payment_id")
  WHERE "contract_payment_id" IS NOT NULL AND "status" IN ('received', 'approved', 'paid');
CREATE INDEX "finance_vendor_invoices_status_idx"
  ON "finance_vendor_invoices"("tenant_id", "status", "recorded_at", "id");
CREATE INDEX "finance_vendor_invoices_vendor_idx"
  ON "finance_vendor_invoices"("tenant_id", "vendor_id", "recorded_at" DESC, "id" DESC);
CREATE INDEX "finance_vendor_invoices_contract_idx"
  ON "finance_vendor_invoices"("tenant_id", "contract_id") WHERE "contract_id" IS NOT NULL;
CREATE INDEX "finance_vendor_invoices_purchase_idx"
  ON "finance_vendor_invoices"("tenant_id", "purchase_request_id") WHERE "purchase_request_id" IS NOT NULL;
-- Approved and unpaid: what a line holds to pay, and the schedule.
CREATE INDEX "finance_vendor_invoices_payable_idx"
  ON "finance_vendor_invoices"("tenant_id", "budget_line_id", "due_on") WHERE "status" = 'approved';
ALTER TABLE "finance_vendor_invoices"
  ADD CONSTRAINT "finance_vendor_invoices_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_vendor_invoices_vendor_fkey"
  FOREIGN KEY ("tenant_id", "vendor_id") REFERENCES "vendors"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_vendor_invoices_contract_fkey"
  FOREIGN KEY ("tenant_id", "contract_id") REFERENCES "maintenance_contracts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_vendor_invoices_purchase_fkey"
  FOREIGN KEY ("tenant_id", "purchase_request_id") REFERENCES "purchase_requests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_vendor_invoices_line_fkey"
  FOREIGN KEY ("tenant_id", "budget_line_id") REFERENCES "finance_budget_lines"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_vendor_invoices_authorization_fkey"
  FOREIGN KEY ("tenant_id", "authorization_id") REFERENCES "finance_expense_authorizations"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_vendor_invoices_file_fkey"
  FOREIGN KEY ("tenant_id", "invoice_file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_vendor_invoices_recorded_by_fkey"
  FOREIGN KEY ("tenant_id", "recorded_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_vendor_invoices_decided_by_fkey"
  FOREIGN KEY ("tenant_id", "decided_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_vendor_invoices_cancelled_by_fkey"
  FOREIGN KEY ("tenant_id", "cancelled_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_vendor_invoices" ADD CONSTRAINT "finance_vendor_invoices_shape"
  CHECK ("number" > 0
     AND "channel" IN ('office')
     AND char_length("vendor_number") BETWEEN 1 AND 60
     AND "issued_on" <= "due_on"
     AND ("note" IS NULL OR char_length("note") BETWEEN 1 AND 500)
     AND "subtotal" > 0 AND "tax" >= 0 AND "total" = "subtotal" + "tax"
     AND "total" <= 999999999.99);
-- Against a contract (a line of its schedule, or the contract) or a
-- purchase request, never both.
ALTER TABLE "finance_vendor_invoices" ADD CONSTRAINT "finance_vendor_invoices_source"
  CHECK (("contract_id" IS NULL) <> ("purchase_request_id" IS NULL)
     AND ("contract_payment_id" IS NULL OR "contract_id" IS NOT NULL));
-- Each state with what made it. REASON_CODES.vendorInvoiceReject and
-- .vendorInvoiceCancel; a unit test keeps them in step.
ALTER TABLE "finance_vendor_invoices" ADD CONSTRAINT "finance_vendor_invoices_state_shape"
  CHECK ("status" IN ('received', 'approved', 'rejected', 'cancelled', 'paid')
     AND (("decided_at" IS NULL) = ("decided_by_account_id" IS NULL))
     AND ("status" NOT IN ('approved', 'rejected', 'paid') OR "decided_at" IS NOT NULL)
     AND ("status" <> 'received' OR "decided_at" IS NULL)
     AND ("status" NOT IN ('approved', 'paid') OR "budget_line_id" IS NOT NULL)
     AND (("status" = 'rejected') = ("reject_reason" IS NOT NULL))
     AND ("reject_reason" IS NULL
          OR "reject_reason" IN ('wrong_amount', 'not_delivered', 'duplicate', 'not_ours', 'other'))
     AND (("status" = 'cancelled') = ("cancelled_at" IS NOT NULL))
     AND (("cancelled_at" IS NULL) = ("cancelled_by_account_id" IS NULL))
     AND (("cancelled_at" IS NULL) = ("cancel_reason" IS NULL))
     AND ("cancel_reason" IS NULL
          OR "cancel_reason" IN ('entered_in_error', 'vendor_withdrew', 'duplicate', 'other'))
     AND (("status" = 'paid') = ("paid_at" IS NOT NULL)));

-- Terms fixed (a line may be named until the decision); forward only:
-- received → approved | rejected | cancelled; approved → paid | cancelled.
CREATE FUNCTION finance_vendor_invoices_move_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number" AND NEW."channel" = OLD."channel"
     AND NEW."vendor_id" = OLD."vendor_id"
     AND NEW."vendor_number" = OLD."vendor_number"
     AND NEW."issued_on" = OLD."issued_on" AND NEW."due_on" = OLD."due_on"
     AND NEW."contract_id" IS NOT DISTINCT FROM OLD."contract_id"
     AND NEW."contract_payment_id" IS NOT DISTINCT FROM OLD."contract_payment_id"
     AND NEW."purchase_request_id" IS NOT DISTINCT FROM OLD."purchase_request_id"
     AND NEW."invoice_file_id" = OLD."invoice_file_id"
     AND NEW."subtotal" = OLD."subtotal" AND NEW."tax" = OLD."tax" AND NEW."total" = OLD."total"
     AND NEW."note" IS NOT DISTINCT FROM OLD."note"
     AND NEW."recorded_by_account_id" = OLD."recorded_by_account_id"
     AND NEW."recorded_at" = OLD."recorded_at"
     AND ((OLD."status" = 'received' AND NEW."status" IN ('approved', 'rejected', 'cancelled'))
       OR (OLD."status" = 'approved' AND NEW."status" IN ('paid', 'cancelled')
           AND NEW."budget_line_id" = OLD."budget_line_id"
           AND NEW."authorization_id" IS NOT DISTINCT FROM OLD."authorization_id"
           AND NEW."decided_at" = OLD."decided_at"
           AND NEW."decided_by_account_id" = OLD."decided_by_account_id")) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'finance_vendor_invoices: an invoice keeps its terms and moves forward only (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER finance_vendor_invoices_move_forward
  BEFORE UPDATE OR DELETE ON "finance_vendor_invoices"
  FOR EACH ROW EXECUTE FUNCTION finance_vendor_invoices_move_forward();
CREATE TRIGGER finance_vendor_invoices_truncate
  BEFORE TRUNCATE ON "finance_vendor_invoices"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- An invoice's lines, each with its tax code (zero by default). Append-only.
-- ----------------------------------------------------------------------------
CREATE TABLE "finance_vendor_invoice_lines" (
    "tenant_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "tax_code" TEXT NOT NULL DEFAULT 'zero',
    "tax_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "tax" DECIMAL(14,2) NOT NULL DEFAULT 0,
    CONSTRAINT "finance_vendor_invoice_lines_pkey" PRIMARY KEY ("tenant_id", "invoice_id", "position")
);
ALTER TABLE "finance_vendor_invoice_lines"
  ADD CONSTRAINT "finance_vendor_invoice_lines_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_vendor_invoice_lines_invoice_fkey"
  FOREIGN KEY ("tenant_id", "invoice_id") REFERENCES "finance_vendor_invoices"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- TAX_CODES in src/finance/payables/payable-rules.ts: a code's rate, its
-- tax the amount at the rate to the piastre.
ALTER TABLE "finance_vendor_invoice_lines" ADD CONSTRAINT "finance_vendor_invoice_lines_shape"
  CHECK ("position" BETWEEN 1 AND 50
     AND char_length("description") BETWEEN 1 AND 200
     AND "amount" > 0 AND "amount" <= 999999999.99
     AND (("tax_code" IN ('zero', 'exempt') AND "tax_rate" = 0)
          OR ("tax_code" = 'vat_14' AND "tax_rate" = 14))
     AND "tax" = round("amount" * "tax_rate" / 100, 2));
CREATE TRIGGER finance_vendor_invoice_lines_immutable_rows
  BEFORE UPDATE OR DELETE ON "finance_vendor_invoice_lines"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER finance_vendor_invoice_lines_immutable_truncate
  BEFORE TRUNCATE ON "finance_vendor_invoice_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- At commit: an invoice has lines, and they add up to it.
CREATE FUNCTION finance_vendor_invoices_whole() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  iid uuid;
  i record;
  n integer;
  sub numeric;
  tx numeric;
BEGIN
  IF TG_TABLE_NAME = 'finance_vendor_invoices' THEN
    iid := NEW."id";
  ELSE
    iid := NEW."invoice_id";
  END IF;
  SELECT "subtotal", "tax" INTO i FROM "finance_vendor_invoices" WHERE "id" = iid;
  SELECT count(*), COALESCE(sum("amount"), 0), COALESCE(sum("tax"), 0) INTO n, sub, tx
    FROM "finance_vendor_invoice_lines" WHERE "invoice_id" = iid;
  IF n = 0 OR sub <> i."subtotal" OR tx <> i."tax" THEN
    RAISE EXCEPTION 'vendor invoice %: its lines add up to it', iid
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER finance_vendor_invoices_whole
  AFTER INSERT ON "finance_vendor_invoices" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance_vendor_invoices_whole();
CREATE CONSTRAINT TRIGGER finance_vendor_invoice_lines_whole
  AFTER INSERT ON "finance_vendor_invoice_lines" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance_vendor_invoices_whole();

-- A commitment released by an invoice names it.
ALTER TABLE "finance_commitment_releases" ADD CONSTRAINT "finance_commitment_releases_invoice_fkey"
  FOREIGN KEY ("tenant_id", "vendor_invoice_id") REFERENCES "finance_vendor_invoices"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ----------------------------------------------------------------------------
-- The expense a payout writes (ADR 0055) names its invoice, once.
-- ----------------------------------------------------------------------------
ALTER TABLE "finance_expenses" ADD COLUMN "vendor_invoice_id" UUID;
CREATE UNIQUE INDEX "finance_expenses_vendor_invoice_key"
  ON "finance_expenses"("tenant_id", "vendor_invoice_id") WHERE "vendor_invoice_id" IS NOT NULL;
ALTER TABLE "finance_expenses" ADD CONSTRAINT "finance_expenses_vendor_invoice_fkey"
  FOREIGN KEY ("tenant_id", "vendor_invoice_id") REFERENCES "finance_vendor_invoices"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- An expense keeps its terms and is voided once (ADR 0055); its vendor is
-- set once (ADR 0077); its invoice never changes, and an expense a payout
-- wrote is never voided.
CREATE OR REPLACE FUNCTION finance_expense_moves() RETURNS trigger
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
     AND NEW."vendor_invoice_id" IS NOT DISTINCT FROM OLD."vendor_invoice_id"
     AND (OLD."vendor_id" IS NULL OR NEW."vendor_id" IS NOT DISTINCT FROM OLD."vendor_id") THEN
    IF OLD."voided_at" IS NULL AND (OLD."vendor_invoice_id" IS NULL OR NEW."voided_at" IS NULL) THEN
      RETURN NEW;
    END IF;
    IF NEW."voided_at" IS NOT DISTINCT FROM OLD."voided_at"
       AND NEW."voided_by_account_id" IS NOT DISTINCT FROM OLD."voided_by_account_id"
       AND NEW."void_reason_code" IS NOT DISTINCT FROM OLD."void_reason_code" THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'finance_expenses: an expense keeps its terms and is voided once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- The staff inbox (ADR 0073) gathers a vendor's invoice, an advance and a
-- retention's release waiting for their approver: both type CHECKs are
-- recreated with every type on main (20270518090620 the last before this),
-- so a fresh database and an existing one both end with all of them. No row
-- changes.
ALTER TABLE "staff_inbox_due_hours" DROP CONSTRAINT "staff_inbox_due_hours_type";
ALTER TABLE "staff_inbox_due_hours" ADD CONSTRAINT "staff_inbox_due_hours_type"
  CHECK ("type" IN ('registration', 'identity_change', 'worker_engagement', 'vehicle',
    'booking', 'unit_permit', 'work_permit', 'field_exception', 'plan_request',
    'invoice_dispute', 'decision_appeal', 'management_request', 'purchase_request', 'space_use_request',
    'plan_suggestion', 'follow_up_case', 'recovery_case', 'compensation',
    'ownership_transfer', 'closed_unit_round', 'unit_entry_report',
    'vendor_invoice', 'contract_disbursement'));
ALTER TABLE "staff_inbox_overdue" DROP CONSTRAINT "staff_inbox_overdue_type";
ALTER TABLE "staff_inbox_overdue" ADD CONSTRAINT "staff_inbox_overdue_type"
  CHECK ("type" IN ('registration', 'identity_change', 'worker_engagement', 'vehicle',
    'booking', 'unit_permit', 'work_permit', 'field_exception', 'plan_request',
    'invoice_dispute', 'decision_appeal', 'management_request', 'purchase_request', 'space_use_request',
    'plan_suggestion', 'follow_up_case', 'recovery_case', 'compensation',
    'ownership_transfer', 'closed_unit_round', 'unit_entry_report',
    'vendor_invoice', 'contract_disbursement'));

REVOKE ALL ON "finance_vendor_invoices", "finance_vendor_invoice_lines" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "finance_vendor_invoices" TO jiwar_app;
GRANT SELECT, INSERT ON "finance_vendor_invoice_lines" TO jiwar_app;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_vendor_invoices', 'finance_vendor_invoice_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
