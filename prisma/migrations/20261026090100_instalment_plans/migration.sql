-- ============================================================================
-- Phase R6b — instalment plans (ADR 0048). Staff turn what an open invoice
-- still asks for into 2–24 instalment invoices with their own due dates; the
-- original is closed by a credit note of reason `instalment_plan`. The
-- instalments are ordinary invoices (each from its own one-unit batch), so
-- payments, receipts and reminders work on them unchanged. Cancelling a plan
-- credits its instalments' outstanding and issues one remainder invoice.
-- No personal data: numbers, amounts, dates and staff ids.
-- ============================================================================

CREATE TABLE "instalment_plans" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "unit_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "instalment_count" INTEGER NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_account_id" UUID,
    "remainder_invoice_id" UUID,
    CONSTRAINT "instalment_plans_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "instalment_plans_tenant_id_id_key" ON "instalment_plans"("tenant_id", "id");
CREATE UNIQUE INDEX "instalment_plans_tenant_id_number_key" ON "instalment_plans"("tenant_id", "number");
-- One plan per invoice, ever: a cancelled plan's original stays rescheduled,
-- and its remainder is a new invoice (which may get a plan of its own).
CREATE UNIQUE INDEX "instalment_plans_one_per_invoice" ON "instalment_plans"("tenant_id", "invoice_id");
CREATE UNIQUE INDEX "instalment_plans_remainder_key" ON "instalment_plans"("tenant_id", "remainder_invoice_id");
CREATE INDEX "instalment_plans_unit_idx" ON "instalment_plans"("tenant_id", "unit_id", "created_at", "id");
CREATE INDEX "instalment_plans_created_idx" ON "instalment_plans"("tenant_id", "created_at", "id");
ALTER TABLE "instalment_plans"
  ADD CONSTRAINT "instalment_plans_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "instalment_plans_tenant_id_invoice_id_fkey"
  FOREIGN KEY ("tenant_id", "invoice_id") REFERENCES "invoices"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "instalment_plans_tenant_id_remainder_invoice_id_fkey"
  FOREIGN KEY ("tenant_id", "remainder_invoice_id") REFERENCES "invoices"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "instalment_plans_tenant_id_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "instalment_plans_tenant_id_cancelled_by_fkey"
  FOREIGN KEY ("tenant_id", "cancelled_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "instalment_plans" ADD CONSTRAINT "instalment_plans_number"
  CHECK ("number" > 0);
ALTER TABLE "instalment_plans" ADD CONSTRAINT "instalment_plans_count"
  CHECK ("instalment_count" BETWEEN 2 AND 24);
ALTER TABLE "instalment_plans" ADD CONSTRAINT "instalment_plans_total"
  CHECK ("total" > 0 AND "total" <= 1000000);
-- A cancellation names who, when and the remainder invoice, together.
ALTER TABLE "instalment_plans" ADD CONSTRAINT "instalment_plans_cancel_shape"
  CHECK (("cancelled_at" IS NULL) = ("cancelled_by_account_id" IS NULL)
     AND ("cancelled_at" IS NULL) = ("remainder_invoice_id" IS NULL));

-- A plan never changes, except once: its cancellation, set from null.
CREATE FUNCTION instalment_plan_keeps_its_terms() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number" AND NEW."unit_id" = OLD."unit_id"
     AND NEW."invoice_id" = OLD."invoice_id"
     AND NEW."instalment_count" = OLD."instalment_count"
     AND NEW."total" = OLD."total"
     AND NEW."created_by_account_id" = OLD."created_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND OLD."cancelled_at" IS NULL AND NEW."cancelled_at" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'instalment_plans: only a cancellation, once, may change a plan (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER instalment_plans_keep_terms
  BEFORE UPDATE OR DELETE ON "instalment_plans"
  FOR EACH ROW EXECUTE FUNCTION instalment_plan_keeps_its_terms();
CREATE TRIGGER instalment_plans_immutable_truncate
  BEFORE TRUNCATE ON "instalment_plans"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- An instalment is an invoice that names its plan and its place in it.
-- Adding nullable columns changes only the catalogue: the append-only row
-- triggers do not fire.
-- ----------------------------------------------------------------------------
ALTER TABLE "invoices"
  ADD COLUMN "instalment_plan_id" UUID,
  ADD COLUMN "instalment_position" INTEGER;
CREATE UNIQUE INDEX "invoices_instalment_position_key"
  ON "invoices"("tenant_id", "instalment_plan_id", "instalment_position");
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_tenant_id_instalment_plan_id_fkey"
  FOREIGN KEY ("tenant_id", "instalment_plan_id") REFERENCES "instalment_plans"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_instalment_shape"
  CHECK (("instalment_plan_id" IS NULL) = ("instalment_position" IS NULL)
     AND ("instalment_position" IS NULL OR "instalment_position" BETWEEN 1 AND 24)
     AND ("instalment_plan_id" IS NULL OR "plan_id" IS NULL));
-- An instalment may fall due up to two years out; any other invoice within
-- a year, as before. The API checks the same limits first.
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_due";
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_due"
  CHECK ("due_on" >= "issued_on"
     AND "due_on" <= "issued_on" + CASE WHEN "instalment_plan_id" IS NULL THEN 366 ELSE 730 END);
-- An instalment's one-unit batch carries its due date; the API keeps every
-- other issue within 366 days.
ALTER TABLE "invoice_batches" DROP CONSTRAINT "invoice_batches_due";
ALTER TABLE "invoice_batches" ADD CONSTRAINT "invoice_batches_due"
  CHECK ("due_on" >= "issued_on" AND "due_on" <= "issued_on" + 730);

-- ----------------------------------------------------------------------------
-- A credit note of reason `instalment_plan` names its plan (the conversion
-- closing the original, or a cancellation closing an instalment), and only
-- such a note does. Staff cannot pick the reason: it is a system reason
-- (REASON_CODES.creditNoteSystem).
-- ----------------------------------------------------------------------------
ALTER TABLE "credit_notes" ADD COLUMN "instalment_plan_id" UUID;
CREATE INDEX "credit_notes_instalment_plan_idx" ON "credit_notes"("tenant_id", "instalment_plan_id");
ALTER TABLE "credit_notes"
  ADD CONSTRAINT "credit_notes_tenant_id_instalment_plan_id_fkey"
  FOREIGN KEY ("tenant_id", "instalment_plan_id") REFERENCES "instalment_plans"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_instalment_plan_link"
  CHECK (("reason_code" = 'instalment_plan') = ("instalment_plan_id" IS NOT NULL));
-- REASON_CODES.creditNote + REASON_CODES.creditNoteSystem; a unit test keeps
-- the three in step.
ALTER TABLE "credit_notes" DROP CONSTRAINT "credit_notes_reason";
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_reason"
  CHECK ("reason_code" IN ('billing_error', 'waiver', 'duplicate', 'goodwill', 'other', 'instalment_plan'));

-- Plans and refunds are numbered like the rest (IP-000001, RF-000001).
ALTER TABLE "finance_counters" DROP CONSTRAINT "finance_counters_kind";
ALTER TABLE "finance_counters" ADD CONSTRAINT "finance_counters_kind"
  CHECK ("kind" IN ('invoice', 'credit_note', 'receipt', 'instalment_plan', 'refund'));

-- ----------------------------------------------------------------------------
-- Privileges and RLS. A plan is updated once, by its cancellation.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "instalment_plans" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "instalment_plans" TO jiwar_app;
ALTER TABLE "instalment_plans" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "instalment_plans" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "instalment_plans"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
