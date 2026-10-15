-- ============================================================================
-- Phase R6a — invoices (ADR 0046). An invoice belongs to a unit, is issued in
-- a batch (one unit, a building or every unit) and never changes: a wrong one
-- is corrected by credit notes, new rows that reduce what is owed. What is
-- owed is computed (total − credit notes − live allocations), never stored.
-- Numbers are gapless per compound. No personal data: lines carry the
-- staff's own words, in English and Arabic.
-- ============================================================================

CREATE TYPE "invoice_kind" AS ENUM ('service_charge', 'maintenance', 'other');
CREATE TYPE "invoice_batch_target" AS ENUM ('unit', 'building', 'all');

-- ----------------------------------------------------------------------------
-- Counters: one row per compound and kind, created on first use. A number is
-- taken in the creating transaction (its row lock serialises them), so a
-- rolled-back issue gives its numbers back: no gaps.
-- ----------------------------------------------------------------------------
CREATE TABLE "finance_counters" (
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "finance_counters_pkey" PRIMARY KEY ("tenant_id", "kind")
);
ALTER TABLE "finance_counters" ADD CONSTRAINT "finance_counters_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_counters" ADD CONSTRAINT "finance_counters_kind"
  CHECK ("kind" IN ('invoice', 'credit_note', 'receipt'));
ALTER TABLE "finance_counters" ADD CONSTRAINT "finance_counters_last_number"
  CHECK ("last_number" >= 0);

-- ----------------------------------------------------------------------------
-- Batches: one issue by the staff. Append-only.
-- ----------------------------------------------------------------------------
CREATE TABLE "invoice_batches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "target" "invoice_batch_target" NOT NULL,
    "unit_id" UUID,
    "building" TEXT,
    "kind" "invoice_kind" NOT NULL,
    "unit_count" INTEGER NOT NULL,
    "issued_on" DATE NOT NULL,
    "due_on" DATE NOT NULL,
    "created_by_account_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "invoice_batches_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "invoice_batches_tenant_id_id_key" ON "invoice_batches"("tenant_id", "id");
CREATE INDEX "invoice_batches_created_idx" ON "invoice_batches"("tenant_id", "created_at", "id");
ALTER TABLE "invoice_batches"
  ADD CONSTRAINT "invoice_batches_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "invoice_batches_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "invoice_batches_tenant_id_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- The unit for one unit, the building for a building, neither for all.
ALTER TABLE "invoice_batches" ADD CONSTRAINT "invoice_batches_target_shape"
  CHECK (("target" = 'unit') = ("unit_id" IS NOT NULL)
     AND ("target" = 'building') = ("building" IS NOT NULL));
ALTER TABLE "invoice_batches" ADD CONSTRAINT "invoice_batches_building_length"
  CHECK ("building" IS NULL OR char_length("building") BETWEEN 1 AND 100);
ALTER TABLE "invoice_batches" ADD CONSTRAINT "invoice_batches_unit_count"
  CHECK ("unit_count" BETWEEN 1 AND 3000);
ALTER TABLE "invoice_batches" ADD CONSTRAINT "invoice_batches_due"
  CHECK ("due_on" >= "issued_on" AND "due_on" <= "issued_on" + 366);
CREATE TRIGGER invoice_batches_immutable_rows
  BEFORE UPDATE OR DELETE ON "invoice_batches"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER invoice_batches_immutable_truncate
  BEFORE TRUNCATE ON "invoice_batches"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Invoices: immutable once issued. One per unit per batch.
-- ----------------------------------------------------------------------------
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "batch_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "kind" "invoice_kind" NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "issued_on" DATE NOT NULL,
    "due_on" DATE NOT NULL,
    "created_by_account_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "invoices_tenant_id_id_key" ON "invoices"("tenant_id", "id");
CREATE UNIQUE INDEX "invoices_tenant_id_number_key" ON "invoices"("tenant_id", "number");
CREATE UNIQUE INDEX "invoices_one_per_batch_unit" ON "invoices"("tenant_id", "batch_id", "unit_id");
CREATE INDEX "invoices_unit_idx" ON "invoices"("tenant_id", "unit_id", "due_on", "number");
CREATE INDEX "invoices_created_idx" ON "invoices"("tenant_id", "created_at", "id");
CREATE INDEX "invoices_due_idx" ON "invoices"("tenant_id", "due_on");
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_tenant_id_batch_id_fkey"
  FOREIGN KEY ("tenant_id", "batch_id") REFERENCES "invoice_batches"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "invoices_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "invoices_tenant_id_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_number"
  CHECK ("number" > 0);
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_total"
  CHECK ("total" > 0 AND "total" <= 1000000);
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_currency"
  CHECK ("currency" = 'EGP');
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_due"
  CHECK ("due_on" >= "issued_on" AND "due_on" <= "issued_on" + 366);
CREATE TRIGGER invoices_immutable_rows
  BEFORE UPDATE OR DELETE ON "invoices"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER invoices_immutable_truncate
  BEFORE TRUNCATE ON "invoices"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Lines: what the invoice is for, in both languages. Append-only; their sum
-- is the invoice's total, checked when the transaction commits.
-- ----------------------------------------------------------------------------
CREATE TABLE "invoice_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "description_en" TEXT NOT NULL,
    "description_ar" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "invoice_lines_tenant_id_id_key" ON "invoice_lines"("tenant_id", "id");
CREATE UNIQUE INDEX "invoice_lines_position_key" ON "invoice_lines"("tenant_id", "invoice_id", "position");
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_tenant_id_invoice_id_fkey"
  FOREIGN KEY ("tenant_id", "invoice_id") REFERENCES "invoices"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_position"
  CHECK ("position" BETWEEN 1 AND 20);
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_descriptions"
  CHECK (char_length("description_en") BETWEEN 1 AND 200
     AND char_length("description_ar") BETWEEN 1 AND 200);
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_amount"
  CHECK ("amount" > 0 AND "amount" <= 1000000);
CREATE TRIGGER invoice_lines_immutable_rows
  BEFORE UPDATE OR DELETE ON "invoice_lines"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER invoice_lines_immutable_truncate
  BEFORE TRUNCATE ON "invoice_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Credit notes: each reduces what one invoice asks for, by a reason's code.
-- Append-only; no free text.
-- ----------------------------------------------------------------------------
CREATE TABLE "credit_notes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "invoice_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason_code" TEXT NOT NULL,
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "credit_notes_tenant_id_id_key" ON "credit_notes"("tenant_id", "id");
CREATE UNIQUE INDEX "credit_notes_tenant_id_number_key" ON "credit_notes"("tenant_id", "number");
CREATE INDEX "credit_notes_invoice_idx" ON "credit_notes"("tenant_id", "invoice_id", "created_at");
ALTER TABLE "credit_notes"
  ADD CONSTRAINT "credit_notes_tenant_id_invoice_id_fkey"
  FOREIGN KEY ("tenant_id", "invoice_id") REFERENCES "invoices"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "credit_notes_tenant_id_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_number"
  CHECK ("number" > 0);
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_amount"
  CHECK ("amount" > 0 AND "amount" <= 1000000);
-- REASON_CODES.creditNote; a unit test keeps the two in step.
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_reason"
  CHECK ("reason_code" IN ('billing_error', 'waiver', 'duplicate', 'goodwill', 'other'));
CREATE TRIGGER credit_notes_immutable_rows
  BEFORE UPDATE OR DELETE ON "credit_notes"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER credit_notes_immutable_truncate
  BEFORE TRUNCATE ON "credit_notes"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- What the unit's people were told about an invoice: issued, due soon,
-- overdue — each once, claimed by its unique row before the notification is
-- written. A small batch is told at once; a big one by the sweep. Append-only.
-- ----------------------------------------------------------------------------
CREATE TABLE "invoice_notices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "invoice_notices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "invoice_notices_once" ON "invoice_notices"("tenant_id", "invoice_id", "kind");
ALTER TABLE "invoice_notices" ADD CONSTRAINT "invoice_notices_tenant_id_invoice_id_fkey"
  FOREIGN KEY ("tenant_id", "invoice_id") REFERENCES "invoices"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "invoice_notices" ADD CONSTRAINT "invoice_notices_kind"
  CHECK ("kind" IN ('issued', 'due_soon', 'overdue'));
CREATE TRIGGER invoice_notices_immutable_rows
  BEFORE UPDATE OR DELETE ON "invoice_notices"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER invoice_notices_immutable_truncate
  BEFORE TRUNCATE ON "invoice_notices"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- What the database guarantees at commit, whatever the code did: an
-- invoice's lines add up to its total, and its credit notes never exceed
-- it. A backstop for mistakes: the per-unit lock is what keeps two writers
-- apart (ADR 0046). Redefined when payments are added (allocations count).
-- ----------------------------------------------------------------------------
CREATE FUNCTION finance_invoice_lines_add_up() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  inv uuid;
  total numeric;
  lines numeric;
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
  SELECT i."total", COALESCE((SELECT SUM(l."amount") FROM "invoice_lines" l
                               WHERE l."tenant_id" = i."tenant_id" AND l."invoice_id" = i."id"), 0)
    INTO total, lines
    FROM "invoices" i WHERE i."tenant_id" = NEW."tenant_id" AND i."id" = inv;
  IF lines IS DISTINCT FROM total THEN
    RAISE EXCEPTION 'invoice %: lines (%) do not add up to the total (%)', inv, lines, total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER invoices_lines_add_up
  AFTER INSERT ON "invoices" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance_invoice_lines_add_up();
CREATE CONSTRAINT TRIGGER invoice_lines_add_up
  AFTER INSERT ON "invoice_lines" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance_invoice_lines_add_up();

CREATE FUNCTION finance_invoice_within_total() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  total numeric;
  taken numeric;
BEGIN
  SELECT i."total",
         COALESCE((SELECT SUM(c."amount") FROM "credit_notes" c
                    WHERE c."tenant_id" = i."tenant_id" AND c."invoice_id" = i."id"), 0)
    INTO total, taken
    FROM "invoices" i WHERE i."tenant_id" = NEW."tenant_id" AND i."id" = NEW."invoice_id";
  IF taken > total THEN
    RAISE EXCEPTION 'invoice %: credit notes and payments (%) exceed its total (%)', NEW."invoice_id", taken, total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER credit_notes_within_total
  AFTER INSERT ON "credit_notes" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance_invoice_within_total();

-- ----------------------------------------------------------------------------
-- Privileges and RLS. Nothing here is updated or deleted, except a counter's
-- last number.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "finance_counters", "invoice_batches", "invoices", "invoice_lines",
  "credit_notes", "invoice_notices" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "finance_counters" TO jiwar_app;
GRANT SELECT, INSERT ON "invoice_batches", "invoices", "invoice_lines", "credit_notes",
  "invoice_notices" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_counters', 'invoice_batches', 'invoices',
                           'invoice_lines', 'credit_notes', 'invoice_notices'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
