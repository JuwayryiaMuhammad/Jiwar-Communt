-- ============================================================================
-- Taxes and the fiscal year-end close (ADR 0093).
--
-- - `finance_settings`: VAT registered or not (off by default), its number,
--   its rate (14 %), the day it was first turned on, which invoice kinds are
--   taxable and which budget categories' input VAT is recoverable (none by
--   default); withholding on vendor payments on or off (off by default),
--   its rates by category (supplies 1 %, services 3 %, professional fees
--   5 %) and the least invoice it applies to (300 EGP).
-- - A unit's invoice carries its VAT (`vat`, at `vat_rate`), its lines
--   theirs; `total` stays what the unit owes (net + VAT). A credit note
--   carries the share of the invoice's VAT it takes back, set by the
--   database whatever path wrote it.
-- - A vendor's invoice keeps its tax (ADR 0089) and, from its approval, the
--   part of it the compound recovers (`vat_recoverable`, set by the database
--   at the approval); its withholding category (null: its vendor's).
-- - A vendor's payout withholds tax (`withholding`, at `withholding_rate`
--   on `withholding_base`, its category), deducted from what it pays; its
--   certificate (`finance_withholding_certificates`, WHT-) is written with it.
-- - A month's VAT declared once (`finance_vat_declarations`); VAT or
--   withholding paid to the tax authority from a treasury account
--   (`finance_tax_payments`, TXP-, a `tax_payment` movement).
-- - A fiscal year closed (`gl_year_closes`): its closing entry, and its
--   reversal when the manager reopens it.
-- Existing rows carry no tax: nothing is reposted (the owner's decision).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- The compound's settings.
-- ----------------------------------------------------------------------------
ALTER TABLE "finance_settings"
  ADD COLUMN "vat_registered" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "vat_number" TEXT,
  ADD COLUMN "vat_rate" DECIMAL(5,2) NOT NULL DEFAULT 14.00,
  ADD COLUMN "vat_since" DATE,
  ADD COLUMN "vat_taxable_kinds" TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN "vat_recoverable_categories" TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN "withholding_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "withholding_supplies_rate" DECIMAL(5,2) NOT NULL DEFAULT 1.00,
  ADD COLUMN "withholding_services_rate" DECIMAL(5,2) NOT NULL DEFAULT 3.00,
  ADD COLUMN "withholding_professional_rate" DECIMAL(5,2) NOT NULL DEFAULT 5.00,
  ADD COLUMN "withholding_threshold" DECIMAL(14,2) NOT NULL DEFAULT 300.00;
-- Registered: with its number and the day VAT began. The kinds are
-- INVOICE_KINDS, the categories BUDGET_CATEGORIES.
ALTER TABLE "finance_settings" ADD CONSTRAINT "finance_settings_tax_shape"
  CHECK ("vat_rate" > 0 AND "vat_rate" <= 100
     AND ("vat_number" IS NULL OR char_length("vat_number") BETWEEN 1 AND 30)
     AND (NOT "vat_registered" OR ("vat_number" IS NOT NULL AND "vat_since" IS NOT NULL))
     AND "vat_taxable_kinds" <@ ARRAY['service_charge', 'maintenance', 'other', 'facility', 'club',
                                      'fine', 'damage']::text[]
     AND "vat_recoverable_categories" <@ ARRAY['security', 'cleaning', 'landscaping', 'maintenance',
                                               'utilities', 'staff', 'insurance', 'administration',
                                               'reserve_fund', 'other']::text[]
     AND "withholding_supplies_rate" >= 0 AND "withholding_supplies_rate" <= 100
     AND "withholding_services_rate" >= 0 AND "withholding_services_rate" <= 100
     AND "withholding_professional_rate" >= 0 AND "withholding_professional_rate" <= 100
     AND "withholding_threshold" >= 0 AND "withholding_threshold" <= 1000000);

-- ----------------------------------------------------------------------------
-- A unit's invoice and its lines carry their VAT; a credit note its share.
-- ----------------------------------------------------------------------------
ALTER TABLE "invoices"
  ADD COLUMN "vat" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "vat_rate" DECIMAL(5,2) NOT NULL DEFAULT 0;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_vat"
  CHECK ("vat" >= 0 AND "vat" < "total" AND "vat_rate" >= 0 AND "vat_rate" <= 100
     AND ("vat_rate" > 0 OR "vat" = 0));
ALTER TABLE "invoice_lines" ADD COLUMN "vat" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_vat" CHECK ("vat" >= 0);
ALTER TABLE "credit_notes" ADD COLUMN "vat" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_vat"
  CHECK ("vat" >= 0 AND "vat" <= "amount");

-- ADR 0046's commit check, recreated whole: the lines (net and VAT) add up
-- to the invoice's total, and their VAT to its VAT.
CREATE OR REPLACE FUNCTION finance_invoice_lines_add_up() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  inv uuid;
  total numeric;
  vat numeric;
  lines numeric;
  lines_vat numeric;
  same_tx boolean;
BEGIN
  -- One statement per table: PL/pgSQL resolves every field an expression
  -- names, so NEW."invoice_id" must never be read on an invoice.
  IF TG_TABLE_NAME = 'invoices' THEN
    inv := NEW."id";
  ELSE
    inv := NEW."invoice_id";
  END IF;
  -- A line of an invoice this transaction inserted is checked once, by the
  -- invoice's own trigger: a batch of thousands is not summed per line.
  IF TG_TABLE_NAME = 'invoice_lines' THEN
    SELECT i.xmin = pg_current_xact_id()::xid INTO same_tx
      FROM "invoices" i WHERE i."tenant_id" = NEW."tenant_id" AND i."id" = inv;
    IF same_tx THEN
      RETURN NULL;
    END IF;
  END IF;
  SELECT i."total", i."vat",
         COALESCE((SELECT SUM(l."amount" + l."vat") FROM "invoice_lines" l
                    WHERE l."tenant_id" = i."tenant_id" AND l."invoice_id" = i."id"), 0),
         COALESCE((SELECT SUM(l."vat") FROM "invoice_lines" l
                    WHERE l."tenant_id" = i."tenant_id" AND l."invoice_id" = i."id"), 0)
    INTO total, vat, lines, lines_vat
    FROM "invoices" i WHERE i."tenant_id" = NEW."tenant_id" AND i."id" = inv;
  IF lines IS DISTINCT FROM total OR lines_vat IS DISTINCT FROM vat THEN
    RAISE EXCEPTION 'invoice %: lines (% with % VAT) do not add up to the total (% with % VAT)',
      inv, lines, lines_vat, total, vat
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

-- A credit note takes back its share of the invoice's VAT: the amount's
-- share, never more than is left, and what is left when it credits the
-- invoice whole. Rows written earlier by the same statement are seen.
CREATE FUNCTION "credit_notes_vat"() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  i record;
  credited numeric;
  taken numeric;
BEGIN
  SELECT x."total", x."vat" INTO i FROM "invoices" x
   WHERE x."tenant_id" = NEW."tenant_id" AND x."id" = NEW."invoice_id";
  IF i."vat" IS NULL OR i."vat" = 0 THEN
    NEW."vat" := 0;
    RETURN NEW;
  END IF;
  SELECT COALESCE(SUM(c."amount"), 0), COALESCE(SUM(c."vat"), 0) INTO credited, taken
    FROM "credit_notes" c WHERE c."tenant_id" = NEW."tenant_id" AND c."invoice_id" = NEW."invoice_id";
  IF credited + NEW."amount" >= i."total" THEN
    NEW."vat" := GREATEST(i."vat" - taken, 0);
  ELSE
    NEW."vat" := LEAST(round(NEW."amount" * i."vat" / i."total", 2), GREATEST(i."vat" - taken, 0));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "credit_notes_vat" BEFORE INSERT ON "credit_notes"
  FOR EACH ROW EXECUTE FUNCTION "credit_notes_vat"();

-- ----------------------------------------------------------------------------
-- Vendors, their invoices and payouts.
-- ----------------------------------------------------------------------------
-- WITHHOLDING_CATEGORIES; null: by the vendor's trades (professional, then
-- supplies only, else services).
ALTER TABLE "vendors" ADD COLUMN "withholding_category" TEXT;
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_withholding_category"
  CHECK ("withholding_category" IS NULL
      OR "withholding_category" IN ('supplies', 'services', 'professional', 'exempt'));

CREATE FUNCTION "finance_withholding_category"(t uuid, vendor uuid, own text) RETURNS text
  LANGUAGE sql STABLE AS $$
  SELECT COALESCE(own, v."withholding_category",
                  CASE WHEN 'professional' = ANY(v."categories") THEN 'professional'
                       WHEN v."categories" = ARRAY['supplies']::text[] THEN 'supplies'
                       ELSE 'services' END)
    FROM "vendors" v WHERE v."tenant_id" = t AND v."id" = vendor
$$;

ALTER TABLE "finance_vendor_invoices"
  ADD COLUMN "withholding_category" TEXT,
  ADD COLUMN "vat_recoverable" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "finance_vendor_invoices" ADD CONSTRAINT "finance_vendor_invoices_tax_shape"
  CHECK (("withholding_category" IS NULL
          OR "withholding_category" IN ('supplies', 'services', 'professional', 'exempt'))
     AND "vat_recoverable" >= 0 AND "vat_recoverable" <= "tax");

-- ADR 0089's trigger, recreated whole: terms fixed (the withholding
-- category with them), forward only; at its approval the invoice takes the
-- VAT the compound recovers — its tax, while the compound is registered for
-- VAT and its line's category is marked recoverable — and keeps it.
CREATE OR REPLACE FUNCTION finance_vendor_invoices_move_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  s record;
  category text;
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
     AND NEW."withholding_category" IS NOT DISTINCT FROM OLD."withholding_category"
     AND ((OLD."status" = 'received' AND NEW."status" IN ('approved', 'rejected', 'cancelled'))
       OR (OLD."status" = 'approved' AND NEW."status" IN ('paid', 'cancelled')
           AND NEW."budget_line_id" = OLD."budget_line_id"
           AND NEW."authorization_id" IS NOT DISTINCT FROM OLD."authorization_id"
           AND NEW."decided_at" = OLD."decided_at"
           AND NEW."decided_by_account_id" = OLD."decided_by_account_id")) THEN
    IF OLD."status" = 'received' AND NEW."status" = 'approved' THEN
      SELECT f."vat_registered", f."vat_recoverable_categories" INTO s
        FROM "finance_settings" f WHERE f."tenant_id" = NEW."tenant_id";
      SELECT l."category" INTO category FROM "finance_budget_lines" l
       WHERE l."tenant_id" = NEW."tenant_id" AND l."id" = NEW."budget_line_id";
      NEW."vat_recoverable" := CASE WHEN COALESCE(s."vat_registered", false)
                                         AND COALESCE(category, 'other') = ANY(s."vat_recoverable_categories")
                                    THEN NEW."tax" ELSE 0 END;
    ELSE
      NEW."vat_recoverable" := OLD."vat_recoverable";
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'finance_vendor_invoices: an invoice keeps its terms and moves forward only (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

ALTER TABLE "finance_vendor_payouts"
  ADD COLUMN "withholding" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "withholding_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN "withholding_base" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "withholding_category" TEXT;
-- ADR 0089's shape, recreated with the tax withheld: an invoice's payout
-- may withhold (at its category's rate on its base), deducted from what it
-- pays; an advance or a release never does.
ALTER TABLE "finance_vendor_payouts" DROP CONSTRAINT "finance_vendor_payouts_shape";
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
     AND "net" >= 0 AND "net" = "gross" - "retention_held" - "advance_set_off" - "withholding"
     AND "method" IN ('bank_transfer', 'cheque', 'cash')
     AND ("reference" IS NULL OR char_length("reference") BETWEEN 1 AND 100));
ALTER TABLE "finance_vendor_payouts" ADD CONSTRAINT "finance_vendor_payouts_withholding_shape"
  CHECK ("withholding" >= 0 AND "withholding_base" >= 0
     AND "withholding_rate" >= 0 AND "withholding_rate" <= 100
     AND ("kind" = 'invoice' OR ("withholding" = 0 AND "withholding_base" = 0 AND "withholding_rate" = 0))
     AND (("withholding" > 0) = ("withholding_category" IS NOT NULL))
     AND ("withholding" = 0 OR ("withholding_rate" > 0 AND "withholding_base" > 0))
     AND ("withholding_category" IS NULL
          OR "withholding_category" IN ('supplies', 'services', 'professional')));

-- A payout's withholding certificate: what it withheld, once.
CREATE TABLE "finance_withholding_certificates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "payout_id" UUID NOT NULL,
    "vendor_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "rate" DECIMAL(5,2) NOT NULL,
    "base" DECIMAL(14,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "paid_on" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "finance_withholding_certificates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_withholding_certificates_tenant_id_id_key"
  ON "finance_withholding_certificates"("tenant_id", "id");
CREATE UNIQUE INDEX "finance_withholding_certificates_number_key"
  ON "finance_withholding_certificates"("tenant_id", "number");
CREATE UNIQUE INDEX "finance_withholding_certificates_payout_key"
  ON "finance_withholding_certificates"("tenant_id", "payout_id");
CREATE INDEX "finance_withholding_certificates_paid_idx"
  ON "finance_withholding_certificates"("tenant_id", "paid_on", "id");
CREATE INDEX "finance_withholding_certificates_vendor_idx"
  ON "finance_withholding_certificates"("tenant_id", "vendor_id", "paid_on");
ALTER TABLE "finance_withholding_certificates"
  ADD CONSTRAINT "finance_withholding_certificates_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_withholding_certificates_payout_fkey"
  FOREIGN KEY ("tenant_id", "payout_id") REFERENCES "finance_vendor_payouts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_withholding_certificates_vendor_fkey"
  FOREIGN KEY ("tenant_id", "vendor_id") REFERENCES "vendors"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_withholding_certificates" ADD CONSTRAINT "finance_withholding_certificates_shape"
  CHECK ("number" > 0 AND "amount" > 0 AND "base" > 0 AND "rate" > 0 AND "rate" <= 100
     AND "category" IN ('supplies', 'services', 'professional'));
CREATE TRIGGER finance_withholding_certificates_immutable_rows
  BEFORE UPDATE OR DELETE ON "finance_withholding_certificates"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER finance_withholding_certificates_immutable_truncate
  BEFORE TRUNCATE ON "finance_withholding_certificates"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- At commit: a payout that withheld has its certificate, of its terms.
CREATE FUNCTION finance_vendor_payouts_certified() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."withholding" > 0 AND NOT EXISTS (
       SELECT 1 FROM "finance_withholding_certificates" c
        WHERE c."tenant_id" = NEW."tenant_id" AND c."payout_id" = NEW."id"
          AND c."vendor_id" = NEW."vendor_id" AND c."amount" = NEW."withholding"
          AND c."rate" = NEW."withholding_rate" AND c."base" = NEW."withholding_base"
          AND c."category" = NEW."withholding_category" AND c."paid_on" = NEW."paid_on") THEN
    RAISE EXCEPTION 'payout % withheld tax with no certificate of its terms', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER finance_vendor_payouts_certified
  AFTER INSERT ON "finance_vendor_payouts" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance_vendor_payouts_certified();

-- ----------------------------------------------------------------------------
-- A month's VAT declared: its figures, once.
-- ----------------------------------------------------------------------------
CREATE TABLE "finance_vat_declarations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "month" DATE NOT NULL,
    "taxable_sales" DECIMAL(14,2) NOT NULL,
    "output_vat" DECIMAL(14,2) NOT NULL,
    "taxable_purchases" DECIMAL(14,2) NOT NULL,
    "input_vat" DECIMAL(14,2) NOT NULL,
    "carried_in" DECIMAL(14,2) NOT NULL,
    "net_due" DECIMAL(14,2) NOT NULL,
    "carried_out" DECIMAL(14,2) NOT NULL,
    "declared_by_account_id" UUID NOT NULL,
    "declared_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "finance_vat_declarations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_vat_declarations_tenant_id_id_key"
  ON "finance_vat_declarations"("tenant_id", "id");
CREATE UNIQUE INDEX "finance_vat_declarations_month_key"
  ON "finance_vat_declarations"("tenant_id", "month");
ALTER TABLE "finance_vat_declarations"
  ADD CONSTRAINT "finance_vat_declarations_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_vat_declarations_declared_by_fkey"
  FOREIGN KEY ("tenant_id", "declared_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- Due or carried forward, never both: due less carried out is the month's
-- output less its input and what the month before carried in.
ALTER TABLE "finance_vat_declarations" ADD CONSTRAINT "finance_vat_declarations_shape"
  CHECK (extract(day FROM "month") = 1
     AND "carried_in" >= 0 AND "net_due" >= 0 AND "carried_out" >= 0
     AND ("net_due" = 0 OR "carried_out" = 0)
     AND "net_due" - "carried_out" = "output_vat" - "input_vat" - "carried_in");
CREATE TRIGGER finance_vat_declarations_immutable_rows
  BEFORE UPDATE OR DELETE ON "finance_vat_declarations"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER finance_vat_declarations_immutable_truncate
  BEFORE TRUNCATE ON "finance_vat_declarations"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- VAT or withholding paid to the tax authority, from a treasury account.
-- ----------------------------------------------------------------------------
CREATE TABLE "finance_tax_payments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "declaration_id" UUID,
    "quarter" DATE,
    "amount" DECIMAL(14,2) NOT NULL,
    "paid_on" DATE NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "cash_account_id" UUID NOT NULL,
    "paid_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "finance_tax_payments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_tax_payments_tenant_id_id_key" ON "finance_tax_payments"("tenant_id", "id");
CREATE UNIQUE INDEX "finance_tax_payments_number_key" ON "finance_tax_payments"("tenant_id", "number");
CREATE INDEX "finance_tax_payments_paid_idx" ON "finance_tax_payments"("tenant_id", "paid_on", "id");
CREATE INDEX "finance_tax_payments_declaration_idx"
  ON "finance_tax_payments"("tenant_id", "declaration_id") WHERE "declaration_id" IS NOT NULL;
CREATE INDEX "finance_tax_payments_quarter_idx"
  ON "finance_tax_payments"("tenant_id", "quarter") WHERE "quarter" IS NOT NULL;
ALTER TABLE "finance_tax_payments"
  ADD CONSTRAINT "finance_tax_payments_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_tax_payments_declaration_fkey"
  FOREIGN KEY ("tenant_id", "declaration_id") REFERENCES "finance_vat_declarations"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_tax_payments_cash_account_fkey"
  FOREIGN KEY ("tenant_id", "cash_account_id") REFERENCES "finance_cash_accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_tax_payments_paid_by_fkey"
  FOREIGN KEY ("tenant_id", "paid_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- VAT pays a declaration; withholding a calendar quarter (its first day).
ALTER TABLE "finance_tax_payments" ADD CONSTRAINT "finance_tax_payments_shape"
  CHECK ("number" > 0
     AND "kind" IN ('vat', 'withholding')
     AND (("kind" = 'vat') = ("declaration_id" IS NOT NULL))
     AND (("kind" = 'withholding') = ("quarter" IS NOT NULL))
     AND ("quarter" IS NULL
          OR (extract(day FROM "quarter") = 1 AND extract(month FROM "quarter") IN (1, 4, 7, 10)))
     AND "amount" > 0 AND "amount" <= 999999999.99
     AND "method" IN ('bank_transfer', 'cheque', 'cash')
     AND ("reference" IS NULL OR char_length("reference") BETWEEN 1 AND 100));
CREATE TRIGGER finance_tax_payments_immutable_rows
  BEFORE UPDATE OR DELETE ON "finance_tax_payments"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER finance_tax_payments_immutable_truncate
  BEFORE TRUNCATE ON "finance_tax_payments"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- Its movement: the amount, out, on its account and day (ADR 0085), once.
ALTER TABLE "finance_cash_movements" ADD COLUMN "tax_payment_id" UUID;
ALTER TABLE "finance_cash_movements" ADD CONSTRAINT "finance_cash_movements_tax_payment_fkey"
  FOREIGN KEY ("tenant_id", "tax_payment_id") REFERENCES "finance_tax_payments"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE UNIQUE INDEX "finance_cash_movements_one_per_tax_payment"
  ON "finance_cash_movements"("tenant_id", "tax_payment_id") WHERE "tax_payment_id" IS NOT NULL;
ALTER TABLE "finance_cash_movements" DROP CONSTRAINT "finance_cash_movements_kind_known";
ALTER TABLE "finance_cash_movements" ADD CONSTRAINT "finance_cash_movements_kind_known"
  CHECK ("kind" IN ('opening', 'handin', 'recovery', 'transfer', 'cheque',
                    'statement_payment', 'adjustment', 'reversal', 'payout', 'tax_payment'));
ALTER TABLE "finance_cash_movements" DROP CONSTRAINT "finance_cash_movements_amount_range";
ALTER TABLE "finance_cash_movements" ADD CONSTRAINT "finance_cash_movements_amount_range"
  CHECK ("amount" <> 0
     AND (abs("amount") <= 10000000
          OR ("kind" IN ('payout', 'tax_payment') AND abs("amount") <= 999999999.99)));
ALTER TABLE "finance_cash_movements" DROP CONSTRAINT "finance_cash_movements_kind_shape";
ALTER TABLE "finance_cash_movements" ADD CONSTRAINT "finance_cash_movements_kind_shape"
  CHECK ((("kind" IN ('handin', 'recovery')) = ("handin_id" IS NOT NULL))
     AND (("kind" = 'transfer') = ("transfer_id" IS NOT NULL))
     AND (("kind" = 'cheque') = ("cheque_id" IS NOT NULL))
     AND (("kind" = 'statement_payment') <= ("match_id" IS NOT NULL))
     AND (("kind" IN ('statement_payment', 'adjustment', 'reversal')) >= ("match_id" IS NOT NULL))
     AND (("kind" = 'reversal') = ("reverses_id" IS NOT NULL))
     AND (("kind" = 'adjustment') = ("reason_code" IS NOT NULL))
     AND (("kind" = 'payout') = ("payout_id" IS NOT NULL))
     AND (("kind" = 'tax_payment') = ("tax_payment_id" IS NOT NULL))
     AND ("kind" IN ('transfer', 'adjustment', 'reversal', 'payout', 'tax_payment') OR "amount" > 0)
     AND ("kind" NOT IN ('payout', 'tax_payment') OR "amount" < 0));

-- ADR 0085's commit check, recreated whole with a tax payment's movement.
CREATE OR REPLACE FUNCTION finance_cash_movements_balanced() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  legs int;
  total numeric;
  target record;
  paid record;
BEGIN
  IF NEW."kind" = 'transfer' THEN
    SELECT count(*), SUM(m."amount") INTO legs, total
      FROM "finance_cash_movements" m
     WHERE m."tenant_id" = NEW."tenant_id" AND m."transfer_id" = NEW."transfer_id";
    IF legs <> 2 OR total <> 0 THEN
      RAISE EXCEPTION 'transfer %: two legs adding up to zero', NEW."transfer_id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."kind" = 'reversal' THEN
    SELECT m."account_id", m."amount", m."kind" INTO target
      FROM "finance_cash_movements" m
     WHERE m."tenant_id" = NEW."tenant_id" AND m."id" = NEW."reverses_id";
    IF target."kind" NOT IN ('statement_payment', 'adjustment')
       OR target."account_id" <> NEW."account_id"
       OR target."amount" <> -NEW."amount" THEN
      RAISE EXCEPTION 'movement %: a reversal undoes a matched movement exactly', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."kind" = 'payout' THEN
    SELECT p."cash_account_id", p."net", p."paid_on" INTO paid
      FROM "finance_vendor_payouts" p
     WHERE p."tenant_id" = NEW."tenant_id" AND p."id" = NEW."payout_id";
    IF NOT FOUND OR paid."cash_account_id" IS DISTINCT FROM NEW."account_id"
       OR paid."net" <> -NEW."amount"
       OR paid."paid_on" <> NEW."on_day" THEN
      RAISE EXCEPTION 'movement % violates its payout: its net, out, on its account and day', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."kind" = 'tax_payment' THEN
    SELECT p."cash_account_id", p."amount", p."paid_on" INTO paid
      FROM "finance_tax_payments" p
     WHERE p."tenant_id" = NEW."tenant_id" AND p."id" = NEW."tax_payment_id";
    IF NOT FOUND OR paid."cash_account_id" <> NEW."account_id"
       OR paid."amount" <> -NEW."amount"
       OR paid."paid_on" <> NEW."on_day" THEN
      RAISE EXCEPTION 'movement % violates its tax payment: its amount, out, on its account and day', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

-- A tax payment has its movement, checked at commit.
CREATE FUNCTION finance_tax_payments_moved() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "finance_cash_movements" m
                  WHERE m."tenant_id" = NEW."tenant_id" AND m."tax_payment_id" = NEW."id") THEN
    RAISE EXCEPTION 'tax payment % violates its account''s register: paid with no movement', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER finance_tax_payments_moved
  AFTER INSERT ON "finance_tax_payments" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance_tax_payments_moved();

-- ----------------------------------------------------------------------------
-- A fiscal year closed: its closing entry, and the reversal a reopening
-- writes. One live close a year.
-- ----------------------------------------------------------------------------
CREATE TABLE "gl_year_closes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "revenue" DECIMAL(14,2) NOT NULL,
    "expenses" DECIMAL(14,2) NOT NULL,
    "result" DECIMAL(14,2) NOT NULL,
    "entry_id" UUID,
    "closed_by_account_id" UUID NOT NULL,
    "closed_at" TIMESTAMPTZ(3) NOT NULL,
    "reopened_at" TIMESTAMPTZ(3),
    "reopened_by_account_id" UUID,
    "reopen_reason" TEXT,
    "reversal_entry_id" UUID,
    CONSTRAINT "gl_year_closes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gl_year_closes_tenant_id_id_key" ON "gl_year_closes"("tenant_id", "id");
CREATE UNIQUE INDEX "gl_year_closes_one_live" ON "gl_year_closes"("tenant_id", "starts_on")
  WHERE "reopened_at" IS NULL;
CREATE UNIQUE INDEX "gl_year_closes_entry_key" ON "gl_year_closes"("tenant_id", "entry_id")
  WHERE "entry_id" IS NOT NULL;
CREATE UNIQUE INDEX "gl_year_closes_reversal_key" ON "gl_year_closes"("tenant_id", "reversal_entry_id")
  WHERE "reversal_entry_id" IS NOT NULL;
CREATE INDEX "gl_year_closes_starts_idx" ON "gl_year_closes"("tenant_id", "starts_on", "closed_at");
ALTER TABLE "gl_year_closes"
  ADD CONSTRAINT "gl_year_closes_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gl_year_closes_entry_fkey"
  FOREIGN KEY ("tenant_id", "entry_id") REFERENCES "gl_entries"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gl_year_closes_reversal_fkey"
  FOREIGN KEY ("tenant_id", "reversal_entry_id") REFERENCES "gl_entries"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gl_year_closes_closed_by_fkey"
  FOREIGN KEY ("tenant_id", "closed_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gl_year_closes_reopened_by_fkey"
  FOREIGN KEY ("tenant_id", "reopened_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- Twelve months from a first day; the result is revenue less expenses.
-- Reopened with a reason (REASON_CODES.glPeriodReopen; a unit test keeps
-- them in step), and then reversed when it had an entry.
ALTER TABLE "gl_year_closes" ADD CONSTRAINT "gl_year_closes_shape"
  CHECK (extract(day FROM "starts_on") = 1
     AND "ends_on" = ("starts_on" + interval '1 year' - interval '1 day')::date
     AND "result" = "revenue" - "expenses"
     AND (("reopened_at" IS NULL) = ("reopened_by_account_id" IS NULL))
     AND (("reopened_at" IS NULL) = ("reopen_reason" IS NULL))
     AND ("reversal_entry_id" IS NULL OR "reopened_at" IS NOT NULL)
     AND ("reopen_reason" IS NULL
          OR "reopen_reason" IN ('late_document', 'correction', 'audit_finding', 'other')));
-- Reopened once; nothing else changes.
CREATE FUNCTION "gl_year_closes_fixed"() RETURNS trigger AS $$
BEGIN
  IF OLD."reopened_at" IS NOT NULL
     OR NEW."id" <> OLD."id" OR NEW."tenant_id" <> OLD."tenant_id"
     OR NEW."starts_on" <> OLD."starts_on" OR NEW."ends_on" <> OLD."ends_on"
     OR NEW."revenue" <> OLD."revenue" OR NEW."expenses" <> OLD."expenses"
     OR NEW."result" <> OLD."result"
     OR NEW."entry_id" IS DISTINCT FROM OLD."entry_id"
     OR NEW."closed_by_account_id" <> OLD."closed_by_account_id"
     OR NEW."closed_at" <> OLD."closed_at" THEN
    RAISE EXCEPTION 'year close %: reopened once, its terms fixed', OLD."id"
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "gl_year_closes_fixed" BEFORE UPDATE ON "gl_year_closes"
  FOR EACH ROW EXECUTE FUNCTION "gl_year_closes_fixed"();
CREATE TRIGGER "gl_year_closes_no_delete" BEFORE DELETE ON "gl_year_closes"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();

-- A month of a closed year, or one whose VAT is declared, is not reopened.
CREATE FUNCTION "gl_periods_locked"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'open' AND OLD."status" = 'closed' THEN
    IF EXISTS (SELECT 1 FROM "gl_year_closes" y
                WHERE y."tenant_id" = NEW."tenant_id" AND y."reopened_at" IS NULL
                  AND NEW."month" BETWEEN y."starts_on" AND y."ends_on") THEN
      RAISE EXCEPTION 'month %: its fiscal year is closed', NEW."month"
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM "finance_vat_declarations" d
                WHERE d."tenant_id" = NEW."tenant_id" AND d."month" = NEW."month") THEN
      RAISE EXCEPTION 'month %: its VAT is declared', NEW."month"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "gl_periods_locked" BEFORE UPDATE ON "gl_periods"
  FOR EACH ROW EXECUTE FUNCTION "gl_periods_locked"();

-- ADR 0092's month checks, recreated: a year's closing entry and its
-- reversal are dated the year's last day, in a month closed by then; every
-- other entry is refused in a closed month, when written and at commit.
CREATE OR REPLACE FUNCTION "gl_entries_open_month"() RETURNS trigger AS $$
BEGIN
  IF NEW."source" NOT IN ('year_close', 'year_reopen')
     AND "gl_month_closed"(NEW."tenant_id", NEW."posted_on") THEN
    RAISE EXCEPTION 'gl entry %: % is in a closed month', NEW."id", NEW."posted_on"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "gl_entries_balanced"() RETURNS trigger AS $$
DECLARE
  n int;
  dr numeric;
  cr numeric;
BEGIN
  SELECT count(*), COALESCE(SUM(l."debit"), 0), COALESCE(SUM(l."credit"), 0) INTO n, dr, cr
    FROM "gl_lines" l WHERE l."tenant_id" = NEW."tenant_id" AND l."entry_id" = NEW."id";
  IF n < 2 OR dr <> cr THEN
    RAISE EXCEPTION 'gl entry %: % lines, debits % and credits % must balance', NEW."id", n, dr, cr
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."source" NOT IN ('year_close', 'year_reopen')
     AND "gl_month_closed"(NEW."tenant_id", NEW."posted_on") THEN
    RAISE EXCEPTION 'gl entry %: % is in a closed month', NEW."id", NEW."posted_on"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- Privileges and RLS.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "finance_withholding_certificates", "finance_vat_declarations",
              "finance_tax_payments", "gl_year_closes" FROM jiwar_app;
GRANT SELECT, INSERT ON "finance_withholding_certificates", "finance_vat_declarations",
                        "finance_tax_payments" TO jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "gl_year_closes" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_withholding_certificates', 'finance_vat_declarations',
                           'finance_tax_payments', 'gl_year_closes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
