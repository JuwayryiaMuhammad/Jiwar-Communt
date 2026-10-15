-- ============================================================================
-- Phase R6a — payments and receipts (ADR 0046). A payment belongs to a unit
-- and is append-only: a wrong one is reversed by a new row, never edited.
-- Allocations say which invoices a payment paid, oldest due first; they are
-- append-only too, and stop counting when their payment is reversed (that is
-- computed, never written). What a unit paid beyond what it owes is its
-- credit, applied to its next invoices. Each payment has a receipt: a number
-- and a random code anyone can verify on the public page through a global
-- pointer that holds the code's hash only.
-- ============================================================================

CREATE TYPE "payment_kind" AS ENUM ('payment', 'reversal');
CREATE TYPE "payment_channel" AS ENUM ('office', 'online');
CREATE TYPE "payment_method" AS ENUM ('cash', 'bank_transfer', 'cheque', 'card', 'wallet');

CREATE TABLE "finance_payments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "payment_kind" NOT NULL,
    "unit_id" UUID NOT NULL,
    "channel" "payment_channel",
    "method" "payment_method",
    "amount" DECIMAL(12,2),
    "currency" TEXT,
    "paid_on" DATE,
    "receipt_number" INTEGER,
    "receipt_code" TEXT,
    "reference" TEXT,
    "recorded_by_account_id" UUID,
    "reverses_id" UUID,
    "reason_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "finance_payments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_payments_tenant_id_id_key" ON "finance_payments"("tenant_id", "id");
CREATE UNIQUE INDEX "finance_payments_one_reversal" ON "finance_payments"("tenant_id", "reverses_id");
CREATE UNIQUE INDEX "finance_payments_receipt_number_key"
  ON "finance_payments"("tenant_id", "receipt_number") WHERE "kind" = 'payment';
CREATE UNIQUE INDEX "finance_payments_receipt_code_key"
  ON "finance_payments"("receipt_code") WHERE "receipt_code" IS NOT NULL;
CREATE INDEX "finance_payments_unit_idx" ON "finance_payments"("tenant_id", "unit_id", "created_at", "id");
CREATE INDEX "finance_payments_created_idx" ON "finance_payments"("tenant_id", "created_at", "id");
ALTER TABLE "finance_payments"
  ADD CONSTRAINT "finance_payments_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_payments_tenant_id_recorded_by_fkey"
  FOREIGN KEY ("tenant_id", "recorded_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_payments_tenant_id_reverses_id_fkey"
  FOREIGN KEY ("tenant_id", "reverses_id") REFERENCES "finance_payments"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- A payment says what, how and its receipt; a reversal names the payment
-- and why. Nullable columns appear only under IS [NOT] NULL here.
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_kind_shape"
  CHECK (("kind" = 'payment') = ("channel" IS NOT NULL)
     AND ("kind" = 'payment') = ("method" IS NOT NULL)
     AND ("kind" = 'payment') = ("amount" IS NOT NULL)
     AND ("kind" = 'payment') = ("currency" IS NOT NULL)
     AND ("kind" = 'payment') = ("paid_on" IS NOT NULL)
     AND ("kind" = 'payment') = ("receipt_number" IS NOT NULL)
     AND ("kind" = 'payment') = ("receipt_code" IS NOT NULL)
     AND ("kind" = 'reversal') = ("reverses_id" IS NOT NULL)
     AND ("kind" = 'reversal') = ("reason_code" IS NOT NULL));
-- At the office: cash, a transfer or a cheque, recorded by someone; the
-- transfer's or cheque's reference, and only theirs. A reversal is recorded
-- by someone too. (Online payments come with the checkout.)
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_office_shape"
  CHECK ("channel" IS NULL OR "channel" <> 'office'
      OR ("method" IN ('cash', 'bank_transfer', 'cheque') AND "recorded_by_account_id" IS NOT NULL));
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_reference_shape"
  CHECK ("method" IS NULL OR ("method" IN ('bank_transfer', 'cheque')) = ("reference" IS NOT NULL));
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_reversal_recorder"
  CHECK ("kind" <> 'reversal' OR "recorded_by_account_id" IS NOT NULL);
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_amount"
  CHECK ("amount" IS NULL OR ("amount" > 0 AND "amount" <= 1000000));
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_currency"
  CHECK ("currency" IS NULL OR "currency" = 'EGP');
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_receipt_number"
  CHECK ("receipt_number" IS NULL OR "receipt_number" > 0);
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_receipt_code_shape"
  CHECK ("receipt_code" IS NULL OR "receipt_code" ~ '^[A-Za-z0-9_-]{22}$');
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_reference_format"
  CHECK ("reference" IS NULL OR "reference" ~ '^[A-Za-z0-9/-]{1,40}$');
-- REASON_CODES.paymentReverse; a unit test keeps the two in step.
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_reason"
  CHECK ("reason_code" IS NULL
      OR "reason_code" IN ('entered_in_error', 'duplicate', 'bounced_cheque', 'other'));
CREATE TRIGGER finance_payments_immutable_rows
  BEFORE UPDATE OR DELETE ON "finance_payments"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER finance_payments_immutable_truncate
  BEFORE TRUNCATE ON "finance_payments"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();
-- A reversal reverses a payment made at the office, of the same unit: an
-- online payment is refunded (R6b), never reversed.
CREATE FUNCTION finance_reversal_targets_office_payment() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  target record;
BEGIN
  IF NEW."kind" = 'reversal' THEN
    SELECT p."kind", p."channel", p."unit_id" INTO target
      FROM "finance_payments" p
     WHERE p."tenant_id" = NEW."tenant_id" AND p."id" = NEW."reverses_id";
    IF target."kind" IS DISTINCT FROM 'payment'
       OR target."channel" IS DISTINCT FROM 'office'
       OR target."unit_id" IS DISTINCT FROM NEW."unit_id" THEN
      RAISE EXCEPTION 'finance_payments: a reversal reverses an office payment of its unit'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER finance_payments_reversal_target
  BEFORE INSERT ON "finance_payments"
  FOR EACH ROW EXECUTE FUNCTION finance_reversal_targets_office_payment();

-- ----------------------------------------------------------------------------
-- Allocations: which invoice a payment paid, and how much. Append-only.
-- ----------------------------------------------------------------------------
CREATE TABLE "finance_allocations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "finance_allocations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_allocations_tenant_id_id_key" ON "finance_allocations"("tenant_id", "id");
CREATE INDEX "finance_allocations_invoice_idx" ON "finance_allocations"("tenant_id", "invoice_id");
CREATE INDEX "finance_allocations_payment_idx" ON "finance_allocations"("tenant_id", "payment_id");
ALTER TABLE "finance_allocations"
  ADD CONSTRAINT "finance_allocations_tenant_id_payment_id_fkey"
  FOREIGN KEY ("tenant_id", "payment_id") REFERENCES "finance_payments"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_allocations_tenant_id_invoice_id_fkey"
  FOREIGN KEY ("tenant_id", "invoice_id") REFERENCES "invoices"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_allocations" ADD CONSTRAINT "finance_allocations_amount"
  CHECK ("amount" > 0 AND "amount" <= 1000000);
CREATE TRIGGER finance_allocations_immutable_rows
  BEFORE UPDATE OR DELETE ON "finance_allocations"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER finance_allocations_immutable_truncate
  BEFORE TRUNCATE ON "finance_allocations"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- The bounds, at commit: an invoice's credit notes and live allocations
-- never exceed its total; a payment's live allocations never exceed its
-- amount. A backstop: the per-unit finance lock keeps writers apart.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION finance_invoice_within_total() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  total numeric;
  taken numeric;
BEGIN
  SELECT i."total",
         COALESCE((SELECT SUM(c."amount") FROM "credit_notes" c
                    WHERE c."tenant_id" = i."tenant_id" AND c."invoice_id" = i."id"), 0)
       + COALESCE((SELECT SUM(a."amount") FROM "finance_allocations" a
                    WHERE a."tenant_id" = i."tenant_id" AND a."invoice_id" = i."id"
                      AND NOT EXISTS (SELECT 1 FROM "finance_payments" r
                                       WHERE r."tenant_id" = a."tenant_id"
                                         AND r."reverses_id" = a."payment_id")), 0)
    INTO total, taken
    FROM "invoices" i WHERE i."tenant_id" = NEW."tenant_id" AND i."id" = NEW."invoice_id";
  IF taken > total THEN
    RAISE EXCEPTION 'invoice %: credit notes and payments (%) exceed its total (%)', NEW."invoice_id", taken, total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER finance_allocations_within_invoice
  AFTER INSERT ON "finance_allocations" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance_invoice_within_total();

CREATE FUNCTION finance_payment_within_amount() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  amount numeric;
  taken numeric;
BEGIN
  SELECT p."amount",
         COALESCE((SELECT SUM(a."amount") FROM "finance_allocations" a
                    WHERE a."tenant_id" = p."tenant_id" AND a."payment_id" = p."id"), 0)
    INTO amount, taken
    FROM "finance_payments" p WHERE p."tenant_id" = NEW."tenant_id" AND p."id" = NEW."payment_id";
  IF taken > amount THEN
    RAISE EXCEPTION 'payment %: allocations (%) exceed its amount (%)', NEW."payment_id", taken, amount
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER finance_allocations_within_payment
  AFTER INSERT ON "finance_allocations" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance_payment_within_amount();

-- ----------------------------------------------------------------------------
-- The public receipt page's pointer: global, before any compound is known,
-- like visitor_pass_links. Only the code's SHA-256; no personal data.
-- ----------------------------------------------------------------------------
CREATE TABLE "receipt_links" (
    "code_hash" CHAR(64) NOT NULL,
    "tenant_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "receipt_links_pkey" PRIMARY KEY ("code_hash")
);
CREATE INDEX "receipt_links_payment_idx" ON "receipt_links"("payment_id");
ALTER TABLE "receipt_links" ADD CONSTRAINT "receipt_links_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "receipt_links" ADD CONSTRAINT "receipt_links_code_hash_shape"
  CHECK ("code_hash" ~ '^[0-9a-f]{64}$');

-- ----------------------------------------------------------------------------
-- Privileges and RLS (the pointer is global). Nothing here is updated or
-- deleted.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "finance_payments", "finance_allocations", "receipt_links" FROM jiwar_app;
GRANT SELECT, INSERT ON "finance_payments", "finance_allocations", "receipt_links" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_payments', 'finance_allocations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
