-- ============================================================================
-- Charges (ADR 0070): a facility booking's fee, a club membership request's
-- price and a vehicle fine, each owed through one invoice of the unit's that
-- the charges port issued (kinds `facility`, `club`, `fine`). One charge per
-- source row, ever, and one per invoice. It is paid once its invoice is
-- settled by payments (stamped in the paying transaction, which runs the
-- source's handler; cleared when a reversed office payment leaves it owed
-- again, never moved) and cancelled once (a credit note of what the
-- invoice could still take, by nobody when the system cancels). Its source,
-- invoice and amount never change (trigger); never deleted. `source_id`
-- points at a booking, a club membership request or a vehicle fine by the
-- source's name: no foreign key, as the audit's targets.
-- ============================================================================

CREATE TABLE "finance_charges" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "source_id" UUID NOT NULL,
    "kind" "invoice_kind" NOT NULL,
    "invoice_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "raised_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    CONSTRAINT "finance_charges_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_charges_tenant_id_id_key" ON "finance_charges"("tenant_id", "id");
CREATE UNIQUE INDEX "finance_charges_source_key" ON "finance_charges"("tenant_id", "source", "source_id");
CREATE UNIQUE INDEX "finance_charges_invoice_key" ON "finance_charges"("tenant_id", "invoice_id");
-- The paying transaction looks for the unit's open charges.
CREATE INDEX "finance_charges_open_idx" ON "finance_charges"("tenant_id", "unit_id")
  WHERE "paid_at" IS NULL AND "cancelled_at" IS NULL;
ALTER TABLE "finance_charges" ADD CONSTRAINT "finance_charges_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_charges" ADD CONSTRAINT "finance_charges_unit_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_charges" ADD CONSTRAINT "finance_charges_invoice_fkey"
  FOREIGN KEY ("tenant_id", "invoice_id") REFERENCES "invoices"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- Each source owes through its own kind (CHARGE_SOURCES, CHARGE_KINDS in
-- src/core/charges/charges.ts).
ALTER TABLE "finance_charges" ADD CONSTRAINT "finance_charges_source_kind"
  CHECK (("source" = 'booking' AND "kind" = 'facility')
      OR ("source" = 'club_request' AND "kind" = 'club')
      OR ("source" = 'vehicle_fine' AND "kind" = 'fine'));
ALTER TABLE "finance_charges" ADD CONSTRAINT "finance_charges_amount"
  CHECK ("amount" > 0 AND "amount" <= 1000000);
-- REASON_CODES.chargeCancel, exactly once cancelled.
ALTER TABLE "finance_charges" ADD CONSTRAINT "finance_charges_cancel_shape"
  CHECK (("cancelled_at" IS NULL) = ("cancel_reason" IS NULL)
     AND ("cancel_reason" IS NULL
          OR "cancel_reason" IN ('booking_cancelled', 'booking_rejected', 'closure', 'appeal_accepted', 'fine_cancelled', 'request_cancelled')));

CREATE FUNCTION finance_charge_keeps_its_terms() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."unit_id" = OLD."unit_id"
     AND NEW."source" = OLD."source"
     AND NEW."source_id" = OLD."source_id"
     AND NEW."kind" = OLD."kind"
     AND NEW."invoice_id" = OLD."invoice_id"
     AND NEW."amount" = OLD."amount"
     AND NEW."raised_at" = OLD."raised_at"
     AND (NEW."paid_at" IS NOT DISTINCT FROM OLD."paid_at"
          OR OLD."paid_at" IS NULL OR NEW."paid_at" IS NULL)
     AND ((NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at"
           AND NEW."cancel_reason" IS NOT DISTINCT FROM OLD."cancel_reason")
          OR OLD."cancelled_at" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'finance_charges: a charge keeps its source, invoice and amount, and is paid and cancelled once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER finance_charges_keep_terms
  BEFORE UPDATE OR DELETE ON "finance_charges"
  FOR EACH ROW EXECUTE FUNCTION finance_charge_keeps_its_terms();
CREATE TRIGGER finance_charges_keep_terms_truncate
  BEFORE TRUNCATE ON "finance_charges"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "finance_charges" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "finance_charges" TO jiwar_app;
ALTER TABLE "finance_charges" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "finance_charges" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "finance_charges"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ----------------------------------------------------------------------------
-- Only the port issues the charges' kinds: the billing plans keep the
-- staff's (STAFF_INVOICE_KINDS in src/finance/invoices/invoice-kinds.ts).
-- ----------------------------------------------------------------------------
ALTER TABLE "billing_plans" ADD CONSTRAINT "billing_plans_staff_kind"
  CHECK ("kind" IN ('service_charge', 'maintenance', 'other'));

-- ----------------------------------------------------------------------------
-- A cancelled charge's credit note: the system's `charge_cancelled`, by the
-- one who cancelled what raised it, or by nobody when the system did (a
-- booker who left). Every other credit note keeps its author.
-- REASON_CODES.creditNote + REASON_CODES.creditNoteSystem.
-- ----------------------------------------------------------------------------
ALTER TABLE "credit_notes" ALTER COLUMN "created_by_account_id" DROP NOT NULL;
ALTER TABLE "credit_notes" DROP CONSTRAINT "credit_notes_reason";
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_reason"
  CHECK ("reason_code" IN ('billing_error', 'waiver', 'duplicate', 'goodwill', 'compensation', 'other', 'instalment_plan', 'dispute', 'charge_cancelled'));
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_author"
  CHECK ("created_by_account_id" IS NOT NULL OR "reason_code" = 'charge_cancelled');

-- ----------------------------------------------------------------------------
-- What a booking of the facility costs (EGP), at peak times when that
-- differs, and until how many hours before its start a resident who cancels
-- is credited in full. No fee: free, as before. A walk-in facility has
-- none.
-- ----------------------------------------------------------------------------
ALTER TABLE "facilities" ADD COLUMN "fee_amount" DECIMAL(12,2);
ALTER TABLE "facilities" ADD COLUMN "peak_fee_amount" DECIMAL(12,2);
ALTER TABLE "facilities" ADD COLUMN "refund_cutoff_hours" INTEGER NOT NULL DEFAULT 24;
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_fees"
  CHECK (("fee_amount" IS NULL OR ("fee_amount" > 0 AND "fee_amount" <= 100000))
     AND ("peak_fee_amount" IS NULL OR ("peak_fee_amount" > 0 AND "peak_fee_amount" <= 100000))
     AND "refund_cutoff_hours" BETWEEN 0 AND 168
     AND ("mode" <> 'walk_in' OR ("fee_amount" IS NULL AND "peak_fee_amount" IS NULL)));
