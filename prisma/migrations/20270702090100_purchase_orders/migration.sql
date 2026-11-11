-- ============================================================================
-- Purchase orders and goods receipts (ADR 0094).
--
-- - A purchase order (PO- number a compound) names a vendor of the register
--   (ADR 0077), a budget line, a delivery day and lines: a stock item, a
--   free description of goods, or a service, each with a quantity, a unit, a
--   unit price and its VAT and withholding categories (ADR 0093). Raised
--   directly, from an approved purchase request or from a tender's award.
-- - It is approved (revision 1) by someone who did not raise it, up to the
--   manager's limit or under the board's approved major contract (ADR
--   0055, 0077); an approved order is amended by a new revision, approved
--   again (`purchase_order_revisions`, the proposal kept whole as JSON;
--   the order's own columns and lines show the revision in force). Moves
--   forward only (a trigger): requested -> approved | rejected | cancelled;
--   approved -> closed.
-- - A goods receipt (GR- number a compound) is what arrived against an
--   order, line by line: the quantity accepted and rejected (a rejection
--   has a reason code), a note, photos; a stock line received into a store
--   writes the stock receipt of ADR 0065 at the order's unit cost. Receipts
--   and their lines and photos are append-only.
-- - A PO and a GR number come from the procurement counters (ADR 0077).
-- Business data of the compound; no personal data.
-- ============================================================================

ALTER TABLE "procurement_counters" DROP CONSTRAINT "procurement_counters_kind_known";
ALTER TABLE "procurement_counters" ADD CONSTRAINT "procurement_counters_kind_known"
  CHECK ("kind" IN ('vendor', 'purchase_request', 'tender', 'purchase_order', 'goods_receipt'));

-- ----------------------------------------------------------------------------
-- Purchase orders.
-- ----------------------------------------------------------------------------
CREATE TABLE "purchase_orders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "vendor_id" UUID NOT NULL,
    "budget_line_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "purchase_request_id" UUID,
    "tender_id" UUID,
    "contract_id" UUID,
    "delivery_on" DATE NOT NULL,
    "note" TEXT,
    "revision" SMALLINT NOT NULL DEFAULT 1,
    "pending_revision" SMALLINT,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "subtotal" DECIMAL(14,2) NOT NULL,
    "tax" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "approval_request_id" UUID,
    "raised_by_account_id" UUID NOT NULL,
    "raised_at" TIMESTAMPTZ(3) NOT NULL,
    "decided_by_account_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" TEXT,
    "reject_reason" TEXT,
    "cancelled_by_account_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "closed_at" TIMESTAMPTZ(3),
    "close_reason" TEXT,
    "sent_by_account_id" UUID,
    "sent_at" TIMESTAMPTZ(3),
    "sent_revision" SMALLINT,
    "acknowledged_by_account_id" UUID,
    "acknowledged_at" TIMESTAMPTZ(3),
    "acknowledged_revision" SMALLINT,
    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "purchase_orders_tenant_id_id_key" ON "purchase_orders"("tenant_id", "id");
CREATE UNIQUE INDEX "purchase_orders_number_key" ON "purchase_orders"("tenant_id", "number");
-- One live order a purchase request.
CREATE UNIQUE INDEX "purchase_orders_request_key"
  ON "purchase_orders"("tenant_id", "purchase_request_id")
  WHERE "purchase_request_id" IS NOT NULL AND "status" IN ('requested', 'approved');
-- A board approval signs one order (the claim lock decides across tables).
CREATE UNIQUE INDEX "purchase_orders_approval_key"
  ON "purchase_orders"("tenant_id", "approval_request_id") WHERE "approval_request_id" IS NOT NULL;
CREATE INDEX "purchase_orders_status_idx"
  ON "purchase_orders"("tenant_id", "status", "raised_at", "id");
CREATE INDEX "purchase_orders_vendor_idx"
  ON "purchase_orders"("tenant_id", "vendor_id", "raised_at" DESC, "id" DESC);
CREATE INDEX "purchase_orders_tender_idx"
  ON "purchase_orders"("tenant_id", "tender_id") WHERE "tender_id" IS NOT NULL;
ALTER TABLE "purchase_orders"
  ADD CONSTRAINT "purchase_orders_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "purchase_orders_vendor_fkey"
  FOREIGN KEY ("tenant_id", "vendor_id") REFERENCES "vendors"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "purchase_orders_budget_line_fkey"
  FOREIGN KEY ("tenant_id", "budget_line_id") REFERENCES "finance_budget_lines"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "purchase_orders_purchase_request_fkey"
  FOREIGN KEY ("tenant_id", "purchase_request_id") REFERENCES "purchase_requests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "purchase_orders_tender_fkey"
  FOREIGN KEY ("tenant_id", "tender_id") REFERENCES "tenders"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "purchase_orders_contract_fkey"
  FOREIGN KEY ("tenant_id", "contract_id") REFERENCES "maintenance_contracts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "purchase_orders_approval_fkey"
  FOREIGN KEY ("tenant_id", "approval_request_id") REFERENCES "governance_approval_requests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "purchase_orders_raised_by_fkey"
  FOREIGN KEY ("tenant_id", "raised_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "purchase_orders_decided_by_fkey"
  FOREIGN KEY ("tenant_id", "decided_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "purchase_orders_cancelled_by_fkey"
  FOREIGN KEY ("tenant_id", "cancelled_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "purchase_orders_sent_by_fkey"
  FOREIGN KEY ("tenant_id", "sent_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "purchase_orders_acknowledged_by_fkey"
  FOREIGN KEY ("tenant_id", "acknowledged_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- What an order is: its source, words and totals.
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_shape"
  CHECK ("number" > 0
     AND "source" IN ('direct', 'purchase_request', 'tender')
     AND (("source" = 'purchase_request') = ("purchase_request_id" IS NOT NULL))
     AND (("source" = 'tender') = ("tender_id" IS NOT NULL))
     AND ("contract_id" IS NULL OR "tender_id" IS NOT NULL)
     AND ("note" IS NULL OR char_length("note") BETWEEN 1 AND 500)
     AND ("decision_note" IS NULL OR char_length("decision_note") BETWEEN 1 AND 1000)
     AND "revision" >= 1
     AND ("pending_revision" IS NULL OR "status" = 'approved')
     AND "subtotal" > 0 AND "tax" >= 0 AND "total" = "subtotal" + "tax"
     AND "total" <= 999999999.99);
-- Each state with what made it, and nothing of a state it never reached.
-- REASON_CODES.purchaseOrderReject and .purchaseOrderCancel; a unit test
-- keeps them in step.
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_state_shape"
  CHECK ("status" IN ('requested', 'approved', 'rejected', 'cancelled', 'closed')
     AND (("decided_at" IS NULL) = ("decided_by_account_id" IS NULL))
     AND ("status" NOT IN ('approved', 'rejected', 'closed') OR "decided_at" IS NOT NULL)
     AND ("status" <> 'requested' OR "decided_at" IS NULL)
     AND (("status" = 'rejected') = ("reject_reason" IS NOT NULL))
     AND ("reject_reason" IS NULL
          OR "reject_reason" IN ('wrong_vendor', 'wrong_price', 'no_budget', 'not_needed', 'other'))
     AND (("cancelled_at" IS NULL) = ("cancelled_by_account_id" IS NULL))
     AND (("cancelled_at" IS NULL) = ("cancel_reason" IS NULL))
     AND ("cancel_reason" IS NULL
          OR "cancel_reason" IN ('vendor_unavailable', 'no_longer_needed', 'duplicate', 'price_changed', 'other'))
     AND (("status" = 'cancelled') = ("cancelled_at" IS NOT NULL AND "closed_at" IS NULL))
     AND (("status" = 'closed') = ("closed_at" IS NOT NULL))
     AND (("closed_at" IS NULL) = ("close_reason" IS NULL))
     AND ("close_reason" IS NULL
          OR ("close_reason" IN ('completed', 'remainder_cancelled')
              AND (("close_reason" = 'remainder_cancelled') = ("cancelled_at" IS NOT NULL))))
     AND ("approval_request_id" IS NULL OR "status" IN ('approved', 'closed'))
     AND (("sent_at" IS NULL) = ("sent_by_account_id" IS NULL))
     AND (("sent_at" IS NULL) = ("sent_revision" IS NULL))
     AND (("acknowledged_at" IS NULL) = ("acknowledged_by_account_id" IS NULL))
     AND (("acknowledged_at" IS NULL) = ("acknowledged_revision" IS NULL)));

-- Forward only: requested -> approved | rejected | cancelled; approved ->
-- closed. What an order is raised from never changes; the vendor never
-- changes; the rest (the revision in force, its lines' totals, the dates,
-- the send and the acknowledgement) moves only while the order is live.
CREATE FUNCTION purchase_orders_move_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number" AND NEW."vendor_id" = OLD."vendor_id"
     AND NEW."source" = OLD."source"
     AND NEW."purchase_request_id" IS NOT DISTINCT FROM OLD."purchase_request_id"
     AND NEW."tender_id" IS NOT DISTINCT FROM OLD."tender_id"
     AND NEW."contract_id" IS NOT DISTINCT FROM OLD."contract_id"
     AND NEW."raised_by_account_id" = OLD."raised_by_account_id"
     AND NEW."raised_at" = OLD."raised_at"
     AND NEW."revision" >= OLD."revision"
     AND (OLD."status" = NEW."status"
          AND OLD."status" IN ('requested', 'approved')
       OR (OLD."status" = 'requested' AND NEW."status" IN ('approved', 'rejected', 'cancelled'))
       OR (OLD."status" = 'approved' AND NEW."status" = 'closed'
           AND NEW."revision" = OLD."revision"
           AND NEW."decided_at" = OLD."decided_at")) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'purchase_orders: an order moves forward only (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER purchase_orders_move_forward
  BEFORE UPDATE OR DELETE ON "purchase_orders"
  FOR EACH ROW EXECUTE FUNCTION purchase_orders_move_forward();
CREATE TRIGGER purchase_orders_move_forward_truncate
  BEFORE TRUNCATE ON "purchase_orders"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- An order's lines: the revision in force. Changed only by an approved
-- revision (the service), never deleted once something was received.
-- ----------------------------------------------------------------------------
CREATE TABLE "purchase_order_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL,
    "kind" TEXT NOT NULL,
    "stock_item_id" UUID,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit" TEXT NOT NULL,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "tax_code" TEXT NOT NULL DEFAULT 'zero',
    "tax_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "withholding_category" TEXT,
    "net" DECIMAL(14,2) NOT NULL,
    "tax" DECIMAL(14,2) NOT NULL,
    CONSTRAINT "purchase_order_lines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "purchase_order_lines_tenant_id_id_key" ON "purchase_order_lines"("tenant_id", "id");
CREATE UNIQUE INDEX "purchase_order_lines_position_key"
  ON "purchase_order_lines"("tenant_id", "purchase_order_id", "position");
CREATE INDEX "purchase_order_lines_item_idx"
  ON "purchase_order_lines"("tenant_id", "stock_item_id") WHERE "stock_item_id" IS NOT NULL;
ALTER TABLE "purchase_order_lines"
  ADD CONSTRAINT "purchase_order_lines_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "purchase_order_lines_order_fkey"
  FOREIGN KEY ("tenant_id", "purchase_order_id") REFERENCES "purchase_orders"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "purchase_order_lines_item_fkey"
  FOREIGN KEY ("tenant_id", "stock_item_id") REFERENCES "stock_items"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- ORDER_UNITS in src/maintenance/purchase-orders/purchase-order-rules.ts
-- (ADR 0065's stock units and the lot, hour, day and month); TAX_CODES in
-- src/finance/payables/payable-rules.ts, a code's rate and its tax the net
-- at the rate to the piastre, the net the quantity at the unit price.
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_shape"
  CHECK ("position" BETWEEN 1 AND 50
     AND "kind" IN ('stock', 'goods', 'service')
     AND (("kind" = 'stock') = ("stock_item_id" IS NOT NULL))
     AND char_length("description") BETWEEN 1 AND 200
     AND "quantity" > 0 AND "quantity" < 1000000
     AND "unit" IN ('piece', 'metre', 'litre', 'kilogram', 'box', 'set', 'pair', 'roll',
                    'lot', 'hour', 'day', 'month')
     AND "unit_price" > 0 AND "unit_price" <= 999999999.99
     AND (("tax_code" IN ('zero', 'exempt') AND "tax_rate" = 0)
          OR ("tax_code" = 'vat_14' AND "tax_rate" = 14))
     AND ("withholding_category" IS NULL
          OR "withholding_category" IN ('supplies', 'services', 'professional', 'exempt'))
     AND "net" = round("quantity" * "unit_price", 2)
     AND "net" > 0 AND "net" <= 999999999.99
     AND "tax" = round("net" * "tax_rate" / 100, 2));

-- At commit: an order has lines, and they add up to it.
CREATE FUNCTION purchase_orders_whole() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  pid uuid;
  o record;
  n integer;
  sub numeric;
  tx numeric;
BEGIN
  IF TG_TABLE_NAME = 'purchase_orders' THEN
    pid := NEW."id";
  ELSE
    pid := NEW."purchase_order_id";
  END IF;
  SELECT "subtotal", "tax" INTO o FROM "purchase_orders" WHERE "id" = pid;
  SELECT count(*), COALESCE(sum("net"), 0), COALESCE(sum("tax"), 0) INTO n, sub, tx
    FROM "purchase_order_lines" WHERE "purchase_order_id" = pid;
  IF n = 0 OR sub <> o."subtotal" OR tx <> o."tax" THEN
    RAISE EXCEPTION 'purchase order %: its lines add up to it', pid
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER purchase_orders_whole
  AFTER INSERT OR UPDATE ON "purchase_orders" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION purchase_orders_whole();
CREATE CONSTRAINT TRIGGER purchase_order_lines_whole
  AFTER INSERT OR UPDATE ON "purchase_order_lines" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION purchase_orders_whole();

-- ----------------------------------------------------------------------------
-- An order's revisions: the first is its raising. The proposal is kept whole
-- (header terms and every line, with the id of the line it changes), so a
-- revision stays readable after later ones. One waits at a time; decided
-- once (a trigger).
-- ----------------------------------------------------------------------------
CREATE TABLE "purchase_order_revisions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "revision" SMALLINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "reason_code" TEXT,
    "budget_line_id" UUID NOT NULL,
    "delivery_on" DATE NOT NULL,
    "note" TEXT,
    "lines" JSONB NOT NULL,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "tax" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "requested_by_account_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL,
    "decided_by_account_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" TEXT,
    "reject_reason" TEXT,
    "approval_request_id" UUID,
    CONSTRAINT "purchase_order_revisions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "purchase_order_revisions_tenant_id_id_key"
  ON "purchase_order_revisions"("tenant_id", "id");
CREATE UNIQUE INDEX "purchase_order_revisions_number_key"
  ON "purchase_order_revisions"("tenant_id", "purchase_order_id", "revision");
-- One revision waits at a time.
CREATE UNIQUE INDEX "purchase_order_revisions_waiting_key"
  ON "purchase_order_revisions"("tenant_id", "purchase_order_id") WHERE "status" = 'requested';
CREATE INDEX "purchase_order_revisions_requested_idx"
  ON "purchase_order_revisions"("tenant_id", "status", "requested_at", "id");
ALTER TABLE "purchase_order_revisions"
  ADD CONSTRAINT "purchase_order_revisions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "purchase_order_revisions_order_fkey"
  FOREIGN KEY ("tenant_id", "purchase_order_id") REFERENCES "purchase_orders"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "purchase_order_revisions_budget_line_fkey"
  FOREIGN KEY ("tenant_id", "budget_line_id") REFERENCES "finance_budget_lines"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "purchase_order_revisions_requested_by_fkey"
  FOREIGN KEY ("tenant_id", "requested_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "purchase_order_revisions_decided_by_fkey"
  FOREIGN KEY ("tenant_id", "decided_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "purchase_order_revisions_approval_fkey"
  FOREIGN KEY ("tenant_id", "approval_request_id") REFERENCES "governance_approval_requests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- REASON_CODES.purchaseOrderAmend (the first revision, the raising, has no
-- reason) and .purchaseOrderReject.
ALTER TABLE "purchase_order_revisions" ADD CONSTRAINT "purchase_order_revisions_shape"
  CHECK ("revision" >= 1
     AND "status" IN ('requested', 'approved', 'rejected', 'withdrawn')
     AND ("reason_code" IS NULL
          OR "reason_code" IN ('price_change', 'quantity_change', 'delivery_date', 'item_added',
                               'item_removed', 'other'))
     AND (("revision" = 1) = ("reason_code" IS NULL))
     AND ("note" IS NULL OR char_length("note") BETWEEN 1 AND 500)
     AND ("decision_note" IS NULL OR char_length("decision_note") BETWEEN 1 AND 1000)
     AND jsonb_typeof("lines") = 'array'
     AND "subtotal" > 0 AND "tax" >= 0 AND "total" = "subtotal" + "tax"
     AND "total" <= 999999999.99
     AND (("decided_at" IS NULL) = ("decided_by_account_id" IS NULL))
     AND (("status" = 'requested') = ("decided_at" IS NULL))
     AND (("status" = 'rejected') = ("reject_reason" IS NOT NULL))
     AND ("reject_reason" IS NULL
          OR "reject_reason" IN ('wrong_vendor', 'wrong_price', 'no_budget', 'not_needed', 'other'))
     AND ("approval_request_id" IS NULL OR "status" = 'approved'));
CREATE FUNCTION purchase_order_revisions_move_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."status" = 'requested'
     AND NEW."status" IN ('approved', 'rejected', 'withdrawn')
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."purchase_order_id" = OLD."purchase_order_id"
     AND NEW."revision" = OLD."revision"
     AND NEW."reason_code" IS NOT DISTINCT FROM OLD."reason_code"
     AND NEW."budget_line_id" = OLD."budget_line_id"
     AND NEW."delivery_on" = OLD."delivery_on"
     AND NEW."note" IS NOT DISTINCT FROM OLD."note"
     AND NEW."lines" = OLD."lines"
     AND NEW."subtotal" = OLD."subtotal" AND NEW."tax" = OLD."tax" AND NEW."total" = OLD."total"
     AND NEW."requested_by_account_id" = OLD."requested_by_account_id"
     AND NEW."requested_at" = OLD."requested_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'purchase_order_revisions: a revision is decided once and never changed (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER purchase_order_revisions_move_forward
  BEFORE UPDATE OR DELETE ON "purchase_order_revisions"
  FOR EACH ROW EXECUTE FUNCTION purchase_order_revisions_move_forward();
CREATE TRIGGER purchase_order_revisions_truncate
  BEFORE TRUNCATE ON "purchase_order_revisions"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Goods and service receipts. Append-only.
-- ----------------------------------------------------------------------------
CREATE TABLE "goods_receipts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "received_on" DATE NOT NULL,
    "store_id" UUID,
    "delivery_note" TEXT,
    "note" TEXT,
    "received_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "goods_receipts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "goods_receipts_tenant_id_id_key" ON "goods_receipts"("tenant_id", "id");
CREATE UNIQUE INDEX "goods_receipts_number_key" ON "goods_receipts"("tenant_id", "number");
CREATE INDEX "goods_receipts_order_idx"
  ON "goods_receipts"("tenant_id", "purchase_order_id", "created_at", "id");
ALTER TABLE "goods_receipts"
  ADD CONSTRAINT "goods_receipts_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "goods_receipts_order_fkey"
  FOREIGN KEY ("tenant_id", "purchase_order_id") REFERENCES "purchase_orders"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "goods_receipts_store_fkey"
  FOREIGN KEY ("tenant_id", "store_id") REFERENCES "stores"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "goods_receipts_received_by_fkey"
  FOREIGN KEY ("tenant_id", "received_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_shape"
  CHECK ("number" > 0
     AND ("delivery_note" IS NULL OR char_length("delivery_note") BETWEEN 1 AND 60)
     AND ("note" IS NULL OR char_length("note") BETWEEN 1 AND 500));
CREATE TRIGGER goods_receipts_immutable_rows
  BEFORE UPDATE OR DELETE ON "goods_receipts"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER goods_receipts_immutable_truncate
  BEFORE TRUNCATE ON "goods_receipts"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- The stock receipt a stock line wrote links its receipt (ADR 0065: the
-- free-text reference gets a real link where the receipt is an order's).
ALTER TABLE "stock_movements" ADD COLUMN "goods_receipt_id" UUID;
ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_goods_receipt_fkey"
  FOREIGN KEY ("tenant_id", "goods_receipt_id") REFERENCES "goods_receipts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX "stock_movements_goods_receipt_idx"
  ON "stock_movements"("tenant_id", "goods_receipt_id") WHERE "goods_receipt_id" IS NOT NULL;
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_goods_receipt_receive"
  CHECK ("goods_receipt_id" IS NULL OR "kind" = 'receive');

CREATE TABLE "goods_receipt_lines" (
    "tenant_id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "purchase_order_line_id" UUID NOT NULL,
    "accepted" DECIMAL(12,3) NOT NULL,
    "rejected" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "reject_reason" TEXT,
    "note" TEXT,
    "stock_movement_id" UUID,
    CONSTRAINT "goods_receipt_lines_pkey" PRIMARY KEY ("tenant_id", "receipt_id", "purchase_order_line_id")
);
CREATE INDEX "goods_receipt_lines_order_line_idx"
  ON "goods_receipt_lines"("tenant_id", "purchase_order_line_id");
CREATE UNIQUE INDEX "goods_receipt_lines_movement_key"
  ON "goods_receipt_lines"("tenant_id", "stock_movement_id") WHERE "stock_movement_id" IS NOT NULL;
ALTER TABLE "goods_receipt_lines"
  ADD CONSTRAINT "goods_receipt_lines_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "goods_receipt_lines_receipt_fkey"
  FOREIGN KEY ("tenant_id", "receipt_id") REFERENCES "goods_receipts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "goods_receipt_lines_order_line_fkey"
  FOREIGN KEY ("tenant_id", "purchase_order_line_id") REFERENCES "purchase_order_lines"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "goods_receipt_lines_movement_fkey"
  FOREIGN KEY ("tenant_id", "stock_movement_id") REFERENCES "stock_movements"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- REASON_CODES.goodsRejection: a rejection has its reason, and only it.
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_shape"
  CHECK ("accepted" >= 0 AND "accepted" < 1000000
     AND "rejected" >= 0 AND "rejected" < 1000000
     AND "accepted" + "rejected" > 0
     AND (("rejected" > 0) = ("reject_reason" IS NOT NULL))
     AND ("reject_reason" IS NULL
          OR "reject_reason" IN ('damaged', 'defective', 'wrong_item', 'not_as_specified',
                                 'expired', 'other'))
     AND ("note" IS NULL OR char_length("note") BETWEEN 1 AND 500)
     AND ("stock_movement_id" IS NULL OR "accepted" > 0));
CREATE TRIGGER goods_receipt_lines_immutable_rows
  BEFORE UPDATE OR DELETE ON "goods_receipt_lines"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER goods_receipt_lines_immutable_truncate
  BEFORE TRUNCATE ON "goods_receipt_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

CREATE TABLE "goods_receipt_photos" (
    "tenant_id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    CONSTRAINT "goods_receipt_photos_pkey" PRIMARY KEY ("tenant_id", "file_id")
);
CREATE INDEX "goods_receipt_photos_receipt_idx"
  ON "goods_receipt_photos"("tenant_id", "receipt_id");
ALTER TABLE "goods_receipt_photos"
  ADD CONSTRAINT "goods_receipt_photos_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "goods_receipt_photos_receipt_fkey"
  FOREIGN KEY ("tenant_id", "receipt_id") REFERENCES "goods_receipts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "goods_receipt_photos_file_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE TRIGGER goods_receipt_photos_immutable_rows
  BEFORE UPDATE OR DELETE ON "goods_receipt_photos"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER goods_receipt_photos_immutable_truncate
  BEFORE TRUNCATE ON "goods_receipt_photos"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Grants and row security: every table, forced, by the compound.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "purchase_orders", "purchase_order_lines", "purchase_order_revisions",
              "goods_receipts", "goods_receipt_lines", "goods_receipt_photos" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "purchase_orders", "purchase_order_lines" TO jiwar_app;
GRANT DELETE ON "purchase_order_lines" TO jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "purchase_order_revisions" TO jiwar_app;
GRANT SELECT, INSERT ON "goods_receipts", "goods_receipt_lines", "goods_receipt_photos" TO jiwar_app;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['purchase_orders', 'purchase_order_lines', 'purchase_order_revisions',
                           'goods_receipts', 'goods_receipt_lines', 'goods_receipt_photos'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
