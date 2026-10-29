-- ============================================================================
-- The maintenance store (ADR 0065).
--
-- stores            where parts are kept: a code, names, optionally the
--                   common area it is in; retired, never deleted.
-- stock_items       what is kept: a SKU, names, a unit from a closed list,
--                   the level at which to reorder, the average cost of
--                   what was received (null until the first receipt), and
--                   when the reorder warning was sent (cleared once stock
--                   is above the level again).
-- stock_levels      how much of an item a store holds, and how much of
--                   that is reserved for part requests: 0 ≤ reserved ≤
--                   quantity.
-- stock_movements   every change of a level, never edited: a receipt (with
--                   its cost), an adjustment (with a reason), a transfer
--                   (a pair of rows), a part issued to a ticket or returned
--                   from one.
-- part_requests     a technician asks for a part on their ticket; the store
--                   reserves it in a store, issues it, or declines; the
--                   technician may call it off before it is issued.
--
-- A part issued or returned is also a cost entry of its ticket (the
-- columns added to ticket_cost_entries below), at the item's average cost.
-- Quantities have three decimals, money two (EGP).
-- ============================================================================

CREATE TABLE "stores" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "common_area_id" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "stores_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "stores_tenant_id_id_key" ON "stores"("tenant_id", "id");
CREATE UNIQUE INDEX "stores_tenant_id_code_key" ON "stores"("tenant_id", "code");
CREATE INDEX "stores_list_idx" ON "stores"("tenant_id", "created_at", "id");
ALTER TABLE "stores" ADD CONSTRAINT "stores_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "stores" ADD CONSTRAINT "stores_common_area_fkey"
  FOREIGN KEY ("tenant_id", "common_area_id") REFERENCES "common_areas"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "stores" ADD CONSTRAINT "stores_code_shape"
  CHECK ("code" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$');
ALTER TABLE "stores" ADD CONSTRAINT "stores_names_length"
  CHECK (char_length("name_ar") BETWEEN 1 AND 80 AND char_length("name_en") BETWEEN 1 AND 80);

CREATE TABLE "stock_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "reorder_level" DECIMAL(12,3),
    "average_cost" DECIMAL(12,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "reorder_alerted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "stock_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "stock_items_tenant_id_id_key" ON "stock_items"("tenant_id", "id");
CREATE UNIQUE INDEX "stock_items_tenant_id_sku_key" ON "stock_items"("tenant_id", "sku");
CREATE INDEX "stock_items_list_idx" ON "stock_items"("tenant_id", "created_at", "id");
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_sku_shape"
  CHECK ("sku" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$');
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_names_length"
  CHECK (char_length("name_ar") BETWEEN 1 AND 120 AND char_length("name_en") BETWEEN 1 AND 120);
-- STOCK_UNITS in src/maintenance/stock/stock-rules.ts.
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_unit_known"
  CHECK ("unit" IN ('piece', 'metre', 'litre', 'kilogram', 'box', 'set', 'pair', 'roll'));
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_amounts_range"
  CHECK (("reorder_level" IS NULL OR "reorder_level" >= 0)
     AND ("average_cost" IS NULL OR "average_cost" >= 0));
-- A warning stands only while there is a level to be under.
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_alert_shape"
  CHECK ("reorder_alerted_at" IS NULL OR "reorder_level" IS NOT NULL);

CREATE TABLE "stock_levels" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "reserved" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "stock_levels_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "stock_levels_tenant_id_id_key" ON "stock_levels"("tenant_id", "id");
CREATE UNIQUE INDEX "stock_levels_store_item_key" ON "stock_levels"("tenant_id", "store_id", "item_id");
CREATE INDEX "stock_levels_item_idx" ON "stock_levels"("tenant_id", "item_id", "store_id");
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_store_fkey"
  FOREIGN KEY ("tenant_id", "store_id") REFERENCES "stores"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_item_fkey"
  FOREIGN KEY ("tenant_id", "item_id") REFERENCES "stock_items"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- Never below zero, and never more reserved than held.
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_amounts"
  CHECK ("quantity" >= 0 AND "reserved" >= 0 AND "reserved" <= "quantity");

CREATE TABLE "part_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "store_id" UUID,
    "requested_by_account_id" UUID,
    "requested_at" TIMESTAMPTZ(3) NOT NULL,
    "reserved_by_account_id" UUID,
    "reserved_at" TIMESTAMPTZ(3),
    "closed_by_account_id" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "reason_code" TEXT,
    CONSTRAINT "part_requests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "part_requests_tenant_id_id_key" ON "part_requests"("tenant_id", "id");
CREATE INDEX "part_requests_ticket_idx" ON "part_requests"("tenant_id", "ticket_id", "requested_at", "id");
CREATE INDEX "part_requests_queue_idx" ON "part_requests"("tenant_id", "status", "requested_at", "id");
ALTER TABLE "part_requests" ADD CONSTRAINT "part_requests_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "part_requests" ADD CONSTRAINT "part_requests_ticket_fkey"
  FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "tickets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "part_requests" ADD CONSTRAINT "part_requests_item_fkey"
  FOREIGN KEY ("tenant_id", "item_id") REFERENCES "stock_items"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "part_requests" ADD CONSTRAINT "part_requests_store_fkey"
  FOREIGN KEY ("tenant_id", "store_id") REFERENCES "stores"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "part_requests" ADD CONSTRAINT "part_requests_requested_by_fkey"
  FOREIGN KEY ("tenant_id", "requested_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "part_requests" ADD CONSTRAINT "part_requests_reserved_by_fkey"
  FOREIGN KEY ("tenant_id", "reserved_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "part_requests" ADD CONSTRAINT "part_requests_closed_by_fkey"
  FOREIGN KEY ("tenant_id", "closed_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "part_requests" ADD CONSTRAINT "part_requests_quantity_positive"
  CHECK ("quantity" > 0);
-- Requested: nothing chosen. Reserved: in a store, held there. Issued: from
-- that store, closed. Declined (REASON_CODES.partRequestDecline) or
-- cancelled (partRequestCancel): closed with a reason, from either of the
-- first two; a reservation is released with it.
ALTER TABLE "part_requests" ADD CONSTRAINT "part_requests_state_shape"
  CHECK (("status" = 'requested' AND "store_id" IS NULL AND "reserved_at" IS NULL
          AND "closed_at" IS NULL AND "reason_code" IS NULL)
      OR ("status" = 'reserved' AND "store_id" IS NOT NULL AND "reserved_at" IS NOT NULL
          AND "closed_at" IS NULL AND "reason_code" IS NULL)
      OR ("status" = 'issued' AND "store_id" IS NOT NULL AND "reserved_at" IS NOT NULL
          AND "closed_at" IS NOT NULL AND "reason_code" IS NULL)
      OR ("status" = 'declined' AND "closed_at" IS NOT NULL AND "reason_code" IS NOT NULL
          AND "reason_code" IN ('out_of_stock', 'wrong_part', 'not_needed', 'other'))
      OR ("status" = 'cancelled' AND "closed_at" IS NOT NULL AND "reason_code" IS NOT NULL
          AND "reason_code" IN ('not_needed', 'found_elsewhere', 'other')));
ALTER TABLE "part_requests" ADD CONSTRAINT "part_requests_times_after"
  CHECK (("reserved_at" IS NULL OR "reserved_at" >= "requested_at")
     AND ("closed_at" IS NULL OR "closed_at" >= "requested_at"));

-- Forward only, decided once: requested → reserved → issued, or to a close
-- with a reason; a closed request never changes; its ticket, item and
-- quantity never do.
CREATE FUNCTION "part_requests_forward_only"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a part request is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."ticket_id" <> OLD."ticket_id" OR NEW."item_id" <> OLD."item_id"
     OR NEW."quantity" <> OLD."quantity" OR NEW."requested_at" <> OLD."requested_at"
     OR NEW."requested_by_account_id" IS DISTINCT FROM OLD."requested_by_account_id"
     OR OLD."status" IN ('issued', 'declined', 'cancelled')
     OR (OLD."status" = 'requested' AND NEW."status" NOT IN ('reserved', 'declined', 'cancelled'))
     OR (OLD."status" = 'reserved' AND (NEW."status" NOT IN ('issued', 'declined', 'cancelled')
         OR NEW."store_id" <> OLD."store_id" OR NEW."reserved_at" <> OLD."reserved_at")) THEN
    RAISE EXCEPTION 'a part request moves forward once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "part_requests_forward_only" BEFORE UPDATE OR DELETE ON "part_requests"
  FOR EACH ROW EXECUTE FUNCTION "part_requests_forward_only"();

CREATE TABLE "stock_movements" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit_cost" DECIMAL(12,2),
    "reference" TEXT,
    "reason_code" TEXT,
    "transfer_id" UUID,
    "ticket_id" UUID,
    "part_request_id" UUID,
    "actor_account_id" UUID,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "stock_movements_tenant_id_id_key" ON "stock_movements"("tenant_id", "id");
CREATE INDEX "stock_movements_item_idx" ON "stock_movements"("tenant_id", "item_id", "occurred_at" DESC, "id" DESC);
CREATE INDEX "stock_movements_store_idx" ON "stock_movements"("tenant_id", "store_id", "occurred_at" DESC, "id" DESC);
CREATE INDEX "stock_movements_ticket_idx" ON "stock_movements"("tenant_id", "ticket_id", "occurred_at", "id")
  WHERE "ticket_id" IS NOT NULL;
-- A request is issued once; a transfer is two rows, out and in.
CREATE UNIQUE INDEX "stock_movements_issue_once" ON "stock_movements"("part_request_id")
  WHERE "part_request_id" IS NOT NULL;
CREATE UNIQUE INDEX "stock_movements_transfer_pair" ON "stock_movements"("transfer_id", ("quantity" > 0))
  WHERE "transfer_id" IS NOT NULL;
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_item_fkey"
  FOREIGN KEY ("tenant_id", "item_id") REFERENCES "stock_items"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_store_fkey"
  FOREIGN KEY ("tenant_id", "store_id") REFERENCES "stores"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_ticket_fkey"
  FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "tickets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_part_request_fkey"
  FOREIGN KEY ("tenant_id", "part_request_id") REFERENCES "part_requests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_actor_fkey"
  FOREIGN KEY ("tenant_id", "actor_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_reference_length"
  CHECK ("reference" IS NULL OR char_length("reference") BETWEEN 1 AND 60);
-- Each kind carries what it needs and nothing else:
--   receive   in, with its unit cost and maybe a reference (a delivery note)
--   adjust    in or out, with a reason (REASON_CODES.stockAdjust)
--   transfer  in or out, paired by transfer_id
--   issue     out, for a request on a ticket
--   return    in, from a ticket
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_kind_shape"
  CHECK ("quantity" <> 0 AND (
         ("kind" = 'receive' AND "quantity" > 0 AND "unit_cost" IS NOT NULL AND "unit_cost" >= 0
          AND "reason_code" IS NULL AND "transfer_id" IS NULL AND "ticket_id" IS NULL
          AND "part_request_id" IS NULL)
      OR ("kind" = 'adjust' AND "unit_cost" IS NULL AND "reference" IS NULL
          AND "reason_code" IS NOT NULL
          AND "reason_code" IN ('count_correction', 'damaged', 'expired', 'lost', 'found', 'other')
          AND "transfer_id" IS NULL AND "ticket_id" IS NULL AND "part_request_id" IS NULL)
      OR ("kind" = 'transfer' AND "transfer_id" IS NOT NULL AND "unit_cost" IS NULL
          AND "reference" IS NULL AND "reason_code" IS NULL AND "ticket_id" IS NULL
          AND "part_request_id" IS NULL)
      OR ("kind" = 'issue' AND "quantity" < 0 AND "ticket_id" IS NOT NULL
          AND "part_request_id" IS NOT NULL AND "unit_cost" IS NULL AND "reference" IS NULL
          AND "reason_code" IS NULL AND "transfer_id" IS NULL)
      OR ("kind" = 'return' AND "quantity" > 0 AND "ticket_id" IS NOT NULL
          AND "part_request_id" IS NULL AND "unit_cost" IS NULL AND "reference" IS NULL
          AND "reason_code" IS NULL AND "transfer_id" IS NULL)));
CREATE TRIGGER "stock_movements_immutable_rows" BEFORE UPDATE OR DELETE ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER "stock_movements_immutable_truncate" BEFORE TRUNCATE ON "stock_movements"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- A part's cost entry names its item and the movement that wrote it; only
-- a part's entry does, and a movement writes one entry at most.
-- ----------------------------------------------------------------------------
ALTER TABLE "ticket_cost_entries" ADD COLUMN "item_id" UUID;
ALTER TABLE "ticket_cost_entries" ADD COLUMN "movement_id" UUID;
CREATE UNIQUE INDEX "ticket_cost_entries_movement_key" ON "ticket_cost_entries"("movement_id")
  WHERE "movement_id" IS NOT NULL;
ALTER TABLE "ticket_cost_entries" ADD CONSTRAINT "ticket_cost_entries_item_fkey"
  FOREIGN KEY ("tenant_id", "item_id") REFERENCES "stock_items"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ticket_cost_entries" ADD CONSTRAINT "ticket_cost_entries_movement_fkey"
  FOREIGN KEY ("tenant_id", "movement_id") REFERENCES "stock_movements"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ticket_cost_entries" ADD CONSTRAINT "ticket_cost_entries_part_shape"
  CHECK (("kind" = 'part') = ("movement_id" IS NOT NULL)
     AND ("movement_id" IS NULL) = ("item_id" IS NULL));

-- The void touches nothing else, the store's columns included.
CREATE OR REPLACE FUNCTION "ticket_cost_entries_void_once"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a cost entry is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."voided_at" IS NULL AND NEW."voided_at" IS NOT NULL
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."ticket_id" = OLD."ticket_id" AND NEW."kind" = OLD."kind"
     AND NEW."description" IS NOT DISTINCT FROM OLD."description"
     AND NEW."quantity" = OLD."quantity" AND NEW."unit_amount" = OLD."unit_amount"
     AND NEW."amount" = OLD."amount"
     AND NEW."item_id" IS NOT DISTINCT FROM OLD."item_id"
     AND NEW."movement_id" IS NOT DISTINCT FROM OLD."movement_id"
     AND NEW."entered_by_account_id" IS NOT DISTINCT FROM OLD."entered_by_account_id"
     AND NEW."entered_at" = OLD."entered_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a cost entry is voided once and never edited' USING ERRCODE = 'insufficient_privilege';
END $$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- Grants: stores, items and levels change in place (levels and items under
-- FOR UPDATE), requests move forward in place; movements never change.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "stores", "stock_items", "stock_levels", "part_requests", "stock_movements" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "stores", "stock_items", "stock_levels", "part_requests" TO jiwar_app;
GRANT SELECT, INSERT ON "stock_movements" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stores', 'stock_items', 'stock_levels', 'part_requests', 'stock_movements'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
