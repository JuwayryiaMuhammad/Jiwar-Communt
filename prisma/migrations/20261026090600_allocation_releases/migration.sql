-- ============================================================================
-- Phase R6b — allocation release (ADR 0048). A credit note on an invoice that
-- was paid, in part or in full, may exceed what it still owes, up to what
-- credit notes have not yet taken (its total less its credit notes). The
-- excess releases the invoice's newest live allocations back to the unit's
-- credit, as append-only rows; nothing is rewritten. The released money then
-- pays the unit's other open invoices, or waits as credit to be refunded.
-- ============================================================================

CREATE TABLE "finance_allocation_releases" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "allocation_id" UUID NOT NULL,
    "credit_note_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "finance_allocation_releases_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_allocation_releases_tenant_id_id_key"
  ON "finance_allocation_releases"("tenant_id", "id");
CREATE INDEX "finance_allocation_releases_allocation_idx"
  ON "finance_allocation_releases"("tenant_id", "allocation_id");
CREATE INDEX "finance_allocation_releases_credit_note_idx"
  ON "finance_allocation_releases"("tenant_id", "credit_note_id");
CREATE INDEX "finance_allocation_releases_created_idx"
  ON "finance_allocation_releases"("tenant_id", "created_at", "id");
ALTER TABLE "finance_allocation_releases"
  ADD CONSTRAINT "finance_allocation_releases_tenant_id_allocation_id_fkey"
  FOREIGN KEY ("tenant_id", "allocation_id") REFERENCES "finance_allocations"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_allocation_releases_tenant_id_credit_note_id_fkey"
  FOREIGN KEY ("tenant_id", "credit_note_id") REFERENCES "credit_notes"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_allocation_releases" ADD CONSTRAINT "finance_allocation_releases_amount"
  CHECK ("amount" > 0 AND "amount" <= 1000000);
CREATE TRIGGER finance_allocation_releases_immutable_rows
  BEFORE UPDATE OR DELETE ON "finance_allocation_releases"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER finance_allocation_releases_immutable_truncate
  BEFORE TRUNCATE ON "finance_allocation_releases"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- A release frees a live allocation (its payment not reversed), by a credit
-- note on that allocation's own invoice.
CREATE FUNCTION finance_release_targets() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  allocation record;
  note_invoice uuid;
BEGIN
  SELECT a."invoice_id",
         EXISTS (SELECT 1 FROM "finance_payments" r
                  WHERE r."tenant_id" = a."tenant_id" AND r."reverses_id" = a."payment_id") AS reversed
    INTO allocation
    FROM "finance_allocations" a WHERE a."tenant_id" = NEW."tenant_id" AND a."id" = NEW."allocation_id";
  SELECT c."invoice_id" INTO note_invoice
    FROM "credit_notes" c WHERE c."tenant_id" = NEW."tenant_id" AND c."id" = NEW."credit_note_id";
  -- A row that is not there (another compound's, say) is the foreign
  -- keys' to refuse.
  IF allocation."invoice_id" IS NULL OR note_invoice IS NULL THEN
    RETURN NEW;
  END IF;
  IF allocation.reversed OR allocation."invoice_id" <> note_invoice THEN
    RAISE EXCEPTION 'finance_allocation_releases: a credit note releases a live allocation of its own invoice'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER finance_allocation_releases_target
  BEFORE INSERT ON "finance_allocation_releases"
  FOR EACH ROW EXECUTE FUNCTION finance_release_targets();

-- ----------------------------------------------------------------------------
-- The bounds, at commit (a backstop: the unit's finance lock keeps writers
-- apart). An allocation is never released beyond its amount; what counts as
-- paid on an invoice, and as given by a payment, is net of releases.
-- ----------------------------------------------------------------------------
CREATE FUNCTION finance_allocation_within_amount() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  amount numeric;
  released numeric;
BEGIN
  SELECT a."amount",
         COALESCE((SELECT SUM(x."amount") FROM "finance_allocation_releases" x
                    WHERE x."tenant_id" = a."tenant_id" AND x."allocation_id" = a."id"), 0)
    INTO amount, released
    FROM "finance_allocations" a WHERE a."tenant_id" = NEW."tenant_id" AND a."id" = NEW."allocation_id";
  IF released > amount THEN
    RAISE EXCEPTION 'allocation %: releases (%) exceed its amount (%)', NEW."allocation_id", released, amount
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER finance_allocation_releases_within_allocation
  AFTER INSERT ON "finance_allocation_releases" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance_allocation_within_amount();

CREATE OR REPLACE FUNCTION finance_invoice_within_total() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  total numeric;
  taken numeric;
BEGIN
  SELECT i."total",
         COALESCE((SELECT SUM(c."amount") FROM "credit_notes" c
                    WHERE c."tenant_id" = i."tenant_id" AND c."invoice_id" = i."id"), 0)
       + COALESCE((SELECT SUM(a."amount"
                              - COALESCE((SELECT SUM(x."amount") FROM "finance_allocation_releases" x
                                           WHERE x."tenant_id" = a."tenant_id" AND x."allocation_id" = a."id"), 0))
                     FROM "finance_allocations" a
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

CREATE OR REPLACE FUNCTION finance_payment_within_amount() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  amount numeric;
  taken numeric;
BEGIN
  SELECT p."amount",
         COALESCE((SELECT SUM(a."amount") FROM "finance_allocations" a
                    WHERE a."tenant_id" = p."tenant_id" AND a."payment_id" = p."id"), 0)
       - COALESCE((SELECT SUM(x."amount") FROM "finance_allocation_releases" x
                     JOIN "finance_allocations" a ON a."tenant_id" = x."tenant_id" AND a."id" = x."allocation_id"
                    WHERE x."tenant_id" = p."tenant_id" AND a."payment_id" = p."id"), 0)
       + COALESCE((SELECT SUM(s."amount") FROM "finance_refund_sources" s
                    WHERE s."tenant_id" = p."tenant_id" AND s."payment_id" = p."id"
                      AND NOT EXISTS (SELECT 1 FROM "finance_refunds" x
                                       WHERE x."tenant_id" = s."tenant_id"
                                         AND x."reverses_id" = s."refund_id")), 0)
    INTO amount, taken
    FROM "finance_payments" p WHERE p."tenant_id" = NEW."tenant_id" AND p."id" = NEW."payment_id";
  IF taken > amount THEN
    RAISE EXCEPTION 'payment %: allocations and refunds (%) exceed its amount (%)', NEW."payment_id", taken, amount
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

-- ----------------------------------------------------------------------------
-- Privileges and RLS. Nothing here is updated or deleted.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "finance_allocation_releases" FROM jiwar_app;
GRANT SELECT, INSERT ON "finance_allocation_releases" TO jiwar_app;
ALTER TABLE "finance_allocation_releases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "finance_allocation_releases" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "finance_allocation_releases"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
