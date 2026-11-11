-- ============================================================================
-- The three-way match (ADR 0094): a vendor's invoice (ADR 0089) may name a
-- purchase order, its lines naming the order's lines with the quantity and
-- the unit price they bill; matched against the order and what was accepted
-- on receipt, within the compound's tolerances.
--
-- - `finance_settings`: the tolerances (price 2 %, quantity 0 %, an absolute
--   amount of 100 EGP, each a compound's to change) and the amount above
--   which an invoice with no contract needs an order (null: never, the
--   default, so invoices without an order keep working).
-- - An order's budget is the same commitment as a purchase request's, not a
--   second reservation (`finance_commitments.purchase_order_id`): an order
--   raised from a request takes the request's commitment over (the release
--   `ordered`), and an order closed gives its tail back (`closed`).
-- - A mismatch let through is recorded once with its reason
--   (`finance_invoice_match_overrides`), never by who recorded the invoice.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- The compound's settings.
-- ----------------------------------------------------------------------------
ALTER TABLE "finance_settings"
  ADD COLUMN "po_required_above" DECIMAL(14,2),
  ADD COLUMN "match_price_pct" DECIMAL(5,2) NOT NULL DEFAULT 2.00,
  ADD COLUMN "match_quantity_pct" DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN "match_amount" DECIMAL(14,2) NOT NULL DEFAULT 100.00;
ALTER TABLE "finance_settings" ADD CONSTRAINT "finance_settings_match_shape"
  CHECK (("po_required_above" IS NULL OR ("po_required_above" >= 0 AND "po_required_above" <= 999999999.99))
     AND "match_price_pct" >= 0 AND "match_price_pct" <= 100
     AND "match_quantity_pct" >= 0 AND "match_quantity_pct" <= 100
     AND "match_amount" >= 0 AND "match_amount" <= 1000000);

-- ----------------------------------------------------------------------------
-- Commitments: an order keeps its line's budget as a purchase request does.
-- ----------------------------------------------------------------------------
ALTER TABLE "finance_commitments" ADD COLUMN "purchase_order_id" UUID;
ALTER TABLE "finance_commitments"
  ADD CONSTRAINT "finance_commitments_purchase_order_fkey"
  FOREIGN KEY ("tenant_id", "purchase_order_id") REFERENCES "purchase_orders"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE UNIQUE INDEX "finance_commitments_open_order_key"
  ON "finance_commitments"("tenant_id", "purchase_order_id")
  WHERE "closed_at" IS NULL AND "purchase_order_id" IS NOT NULL;
ALTER TABLE "finance_commitments" DROP CONSTRAINT "finance_commitments_shape";
ALTER TABLE "finance_commitments" ADD CONSTRAINT "finance_commitments_shape"
  CHECK ("amount" > 0 AND "amount" <= 999999999.99
     AND "source" IN ('contract', 'purchase_request', 'purchase_order')
     AND (("source" = 'contract')
          = ("contract_id" IS NOT NULL AND "contract_payment_id" IS NOT NULL))
     AND (("source" = 'purchase_request') = ("purchase_request_id" IS NOT NULL))
     AND (("source" = 'purchase_order') = ("purchase_order_id" IS NOT NULL))
     AND ("source" <> 'purchase_request'
          OR ("contract_id" IS NULL AND "contract_payment_id" IS NULL))
     AND ("source" <> 'purchase_order'
          OR ("contract_id" IS NULL AND "contract_payment_id" IS NULL
              AND "purchase_request_id" IS NULL)));

-- Terms fixed; closed once (ADR 0089's trigger, with the order beside the
-- request).
CREATE OR REPLACE FUNCTION finance_commitments_close_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."line_id" = OLD."line_id" AND NEW."source" = OLD."source"
     AND NEW."contract_id" IS NOT DISTINCT FROM OLD."contract_id"
     AND NEW."contract_payment_id" IS NOT DISTINCT FROM OLD."contract_payment_id"
     AND NEW."purchase_request_id" IS NOT DISTINCT FROM OLD."purchase_request_id"
     AND NEW."purchase_order_id" IS NOT DISTINCT FROM OLD."purchase_order_id"
     AND NEW."vendor_id" IS NOT DISTINCT FROM OLD."vendor_id"
     AND NEW."amount" = OLD."amount"
     AND NEW."due_on" IS NOT DISTINCT FROM OLD."due_on"
     AND NEW."created_by_account_id" IS NOT DISTINCT FROM OLD."created_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND OLD."closed_at" IS NULL AND NEW."closed_at" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'finance_commitments: a commitment keeps its terms and closes once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- Released by an invoice, or given back whole: `ordered` (a purchase
-- request's commitment taken over by its order) and `closed` (what an order
-- closed has left) join ADR 0089's reasons.
ALTER TABLE "finance_commitment_releases" DROP CONSTRAINT "finance_commitment_releases_shape";
ALTER TABLE "finance_commitment_releases" ADD CONSTRAINT "finance_commitment_releases_shape"
  CHECK ("amount" > 0 AND "amount" <= 999999999.99
     AND "reason" IN ('invoiced', 'changed', 'cancelled', 'terminated', 'paid_outside',
                      'ordered', 'closed')
     AND (("reason" = 'invoiced') = ("vendor_invoice_id" IS NOT NULL)));

-- ----------------------------------------------------------------------------
-- A vendor's invoice against an order.
-- ----------------------------------------------------------------------------
ALTER TABLE "finance_vendor_invoices" ADD COLUMN "purchase_order_id" UUID;
ALTER TABLE "finance_vendor_invoices"
  ADD CONSTRAINT "finance_vendor_invoices_purchase_order_fkey"
  FOREIGN KEY ("tenant_id", "purchase_order_id") REFERENCES "purchase_orders"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX "finance_vendor_invoices_order_idx"
  ON "finance_vendor_invoices"("tenant_id", "purchase_order_id") WHERE "purchase_order_id" IS NOT NULL;
-- Against a contract (a line of its schedule, or the contract), a purchase
-- request or a purchase order, never two.
ALTER TABLE "finance_vendor_invoices" DROP CONSTRAINT "finance_vendor_invoices_source";
ALTER TABLE "finance_vendor_invoices" ADD CONSTRAINT "finance_vendor_invoices_source"
  CHECK ((("contract_id" IS NOT NULL)::int + ("purchase_request_id" IS NOT NULL)::int
          + ("purchase_order_id" IS NOT NULL)::int) = 1
     AND ("contract_payment_id" IS NULL OR "contract_id" IS NOT NULL));
-- ADR 0089's states with `corrected` among the reasons an invoice is called
-- off (REASON_CODES.vendorInvoiceCancel): the vendor's corrected invoice, or
-- its credit note, replaces it.
ALTER TABLE "finance_vendor_invoices" DROP CONSTRAINT "finance_vendor_invoices_state_shape";
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
          OR "cancel_reason" IN ('entered_in_error', 'vendor_withdrew', 'duplicate', 'corrected', 'other'))
     AND (("status" = 'paid') = ("paid_at" IS NOT NULL)));

-- ADR 0093's trigger, recreated whole: terms fixed (the order with them),
-- forward only, and the VAT recovered at the approval.
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
     AND NEW."purchase_order_id" IS NOT DISTINCT FROM OLD."purchase_order_id"
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

-- An invoice's line names the order's line it bills, with the quantity and
-- the unit price: the amount is the quantity at the price to the piastre. A
-- line of an invoice that names no order, and an extra line of one that
-- does, name none.
ALTER TABLE "finance_vendor_invoice_lines"
  ADD COLUMN "purchase_order_line_id" UUID,
  ADD COLUMN "quantity" DECIMAL(12,3),
  ADD COLUMN "unit_price" DECIMAL(12,2);
ALTER TABLE "finance_vendor_invoice_lines"
  ADD CONSTRAINT "finance_vendor_invoice_lines_order_line_fkey"
  FOREIGN KEY ("tenant_id", "purchase_order_line_id") REFERENCES "purchase_order_lines"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX "finance_vendor_invoice_lines_order_line_idx"
  ON "finance_vendor_invoice_lines"("tenant_id", "purchase_order_line_id")
  WHERE "purchase_order_line_id" IS NOT NULL;
ALTER TABLE "finance_vendor_invoice_lines" ADD CONSTRAINT "finance_vendor_invoice_lines_matched"
  CHECK ((("purchase_order_line_id" IS NULL) = ("quantity" IS NULL))
     AND (("quantity" IS NULL) = ("unit_price" IS NULL))
     AND ("quantity" IS NULL
          OR ("quantity" > 0 AND "quantity" < 1000000 AND "unit_price" > 0
              AND "amount" = round("quantity" * "unit_price", 2))));

-- ----------------------------------------------------------------------------
-- A mismatch let through. Once an invoice, never changed.
-- ----------------------------------------------------------------------------
CREATE TABLE "finance_invoice_match_overrides" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "reason_code" TEXT NOT NULL,
    "note" TEXT,
    "issues" JSONB NOT NULL,
    "overridden_by_account_id" UUID NOT NULL,
    "overridden_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "finance_invoice_match_overrides_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_invoice_match_overrides_tenant_id_id_key"
  ON "finance_invoice_match_overrides"("tenant_id", "id");
CREATE UNIQUE INDEX "finance_invoice_match_overrides_invoice_key"
  ON "finance_invoice_match_overrides"("tenant_id", "invoice_id");
CREATE INDEX "finance_invoice_match_overrides_at_idx"
  ON "finance_invoice_match_overrides"("tenant_id", "overridden_at", "id");
ALTER TABLE "finance_invoice_match_overrides"
  ADD CONSTRAINT "finance_invoice_match_overrides_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_invoice_match_overrides_invoice_fkey"
  FOREIGN KEY ("tenant_id", "invoice_id") REFERENCES "finance_vendor_invoices"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_invoice_match_overrides_by_fkey"
  FOREIGN KEY ("tenant_id", "overridden_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- REASON_CODES.matchOverride; the issues are codes, positions, quantities
-- and amounts.
ALTER TABLE "finance_invoice_match_overrides" ADD CONSTRAINT "finance_invoice_match_overrides_shape"
  CHECK ("reason_code" IN ('vendor_price_agreed', 'delivery_accepted_short', 'receipt_to_follow',
                           'rounding', 'other')
     AND ("note" IS NULL OR char_length("note") BETWEEN 1 AND 500)
     AND jsonb_typeof("issues") = 'array' AND jsonb_array_length("issues") > 0);
CREATE TRIGGER finance_invoice_match_overrides_immutable_rows
  BEFORE UPDATE OR DELETE ON "finance_invoice_match_overrides"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER finance_invoice_match_overrides_immutable_truncate
  BEFORE TRUNCATE ON "finance_invoice_match_overrides"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();
REVOKE ALL ON "finance_invoice_match_overrides" FROM jiwar_app;
GRANT SELECT, INSERT ON "finance_invoice_match_overrides" TO jiwar_app;
ALTER TABLE "finance_invoice_match_overrides" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "finance_invoice_match_overrides" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "finance_invoice_match_overrides"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
