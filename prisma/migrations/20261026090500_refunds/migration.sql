-- ============================================================================
-- Phase R6b — refunds of a unit's credit (ADR 0048). A refund pays back money
-- the unit holds as credit (live payments nothing owed absorbed), recorded by
-- hand: cash, a bank transfer, or a refund made in the gateway's dashboard;
-- no call to the gateway. Append-only: a mistaken refund is reversed by a new
-- row, which returns the money to credit. Each refund says which payments'
-- free money it took (its sources), so the allocator can never pour money
-- that was paid back, and a payment that was refunded cannot be reversed.
-- No personal data: amounts, a channel, an optional reference, staff ids.
-- ============================================================================

CREATE TYPE "refund_kind" AS ENUM ('refund', 'reversal');
CREATE TYPE "refund_channel" AS ENUM ('cash', 'bank_transfer', 'gateway_manual');

CREATE TABLE "finance_refunds" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "refund_kind" NOT NULL,
    "unit_id" UUID NOT NULL,
    "number" INTEGER,
    "amount" DECIMAL(12,2),
    "currency" TEXT,
    "channel" "refund_channel",
    "reference" TEXT,
    "refunded_on" DATE,
    "reverses_id" UUID,
    "reason_code" TEXT,
    "recorded_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "finance_refunds_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_refunds_tenant_id_id_key" ON "finance_refunds"("tenant_id", "id");
CREATE UNIQUE INDEX "finance_refunds_number_key"
  ON "finance_refunds"("tenant_id", "number") WHERE "kind" = 'refund';
CREATE UNIQUE INDEX "finance_refunds_one_reversal" ON "finance_refunds"("tenant_id", "reverses_id");
CREATE INDEX "finance_refunds_unit_idx" ON "finance_refunds"("tenant_id", "unit_id", "created_at", "id");
CREATE INDEX "finance_refunds_created_idx" ON "finance_refunds"("tenant_id", "created_at", "id");
ALTER TABLE "finance_refunds"
  ADD CONSTRAINT "finance_refunds_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_refunds_tenant_id_recorded_by_fkey"
  FOREIGN KEY ("tenant_id", "recorded_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_refunds_tenant_id_reverses_id_fkey"
  FOREIGN KEY ("tenant_id", "reverses_id") REFERENCES "finance_refunds"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- A refund says how much, how and when; a reversal names the refund and
-- why. Nullable columns appear only under IS [NOT] NULL here.
ALTER TABLE "finance_refunds" ADD CONSTRAINT "finance_refunds_kind_shape"
  CHECK (("kind" = 'refund') = ("number" IS NOT NULL)
     AND ("kind" = 'refund') = ("amount" IS NOT NULL)
     AND ("kind" = 'refund') = ("currency" IS NOT NULL)
     AND ("kind" = 'refund') = ("channel" IS NOT NULL)
     AND ("kind" = 'refund') = ("refunded_on" IS NOT NULL)
     AND ("kind" = 'refund' OR "reference" IS NULL)
     AND ("kind" = 'reversal') = ("reverses_id" IS NOT NULL)
     AND ("kind" = 'reversal') = ("reason_code" IS NOT NULL));
ALTER TABLE "finance_refunds" ADD CONSTRAINT "finance_refunds_number"
  CHECK ("number" IS NULL OR "number" > 0);
ALTER TABLE "finance_refunds" ADD CONSTRAINT "finance_refunds_amount"
  CHECK ("amount" IS NULL OR ("amount" > 0 AND "amount" <= 1000000));
ALTER TABLE "finance_refunds" ADD CONSTRAINT "finance_refunds_currency"
  CHECK ("currency" IS NULL OR "currency" = 'EGP');
ALTER TABLE "finance_refunds" ADD CONSTRAINT "finance_refunds_reference_format"
  CHECK ("reference" IS NULL OR "reference" ~ '^[A-Za-z0-9/-]{1,40}$');
-- REASON_CODES.refundReverse; a unit test keeps the three in step.
ALTER TABLE "finance_refunds" ADD CONSTRAINT "finance_refunds_reason"
  CHECK ("reason_code" IS NULL
      OR "reason_code" IN ('entered_in_error', 'refund_failed', 'other'));
CREATE TRIGGER finance_refunds_immutable_rows
  BEFORE UPDATE OR DELETE ON "finance_refunds"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER finance_refunds_immutable_truncate
  BEFORE TRUNCATE ON "finance_refunds"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();
-- A reversal reverses a refund of the same unit.
CREATE FUNCTION finance_refund_reversal_targets_refund() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  target record;
BEGIN
  IF NEW."kind" = 'reversal' THEN
    SELECT r."kind", r."unit_id" INTO target
      FROM "finance_refunds" r
     WHERE r."tenant_id" = NEW."tenant_id" AND r."id" = NEW."reverses_id";
    IF target."kind" IS DISTINCT FROM 'refund'
       OR target."unit_id" IS DISTINCT FROM NEW."unit_id" THEN
      RAISE EXCEPTION 'finance_refunds: a reversal reverses a refund of its unit'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER finance_refunds_reversal_target
  BEFORE INSERT ON "finance_refunds"
  FOR EACH ROW EXECUTE FUNCTION finance_refund_reversal_targets_refund();

-- ----------------------------------------------------------------------------
-- Which live payments' free money a refund took, and how much. Append-only.
-- A source stops counting when its refund is reversed (computed, never
-- written), and the money is the unit's credit again.
-- ----------------------------------------------------------------------------
CREATE TABLE "finance_refund_sources" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "refund_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "finance_refund_sources_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_refund_sources_tenant_id_id_key" ON "finance_refund_sources"("tenant_id", "id");
CREATE UNIQUE INDEX "finance_refund_sources_once" ON "finance_refund_sources"("tenant_id", "refund_id", "payment_id");
CREATE INDEX "finance_refund_sources_payment_idx" ON "finance_refund_sources"("tenant_id", "payment_id");
ALTER TABLE "finance_refund_sources"
  ADD CONSTRAINT "finance_refund_sources_tenant_id_refund_id_fkey"
  FOREIGN KEY ("tenant_id", "refund_id") REFERENCES "finance_refunds"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_refund_sources_tenant_id_payment_id_fkey"
  FOREIGN KEY ("tenant_id", "payment_id") REFERENCES "finance_payments"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_refund_sources" ADD CONSTRAINT "finance_refund_sources_amount"
  CHECK ("amount" > 0 AND "amount" <= 1000000);
CREATE TRIGGER finance_refund_sources_immutable_rows
  BEFORE UPDATE OR DELETE ON "finance_refund_sources"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER finance_refund_sources_immutable_truncate
  BEFORE TRUNCATE ON "finance_refund_sources"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();
-- A source is a refund's (not a reversal's), and takes from a live payment
-- of the same unit.
CREATE FUNCTION finance_refund_source_targets() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  refund record;
  payment record;
BEGIN
  SELECT r."kind", r."unit_id" INTO refund
    FROM "finance_refunds" r WHERE r."tenant_id" = NEW."tenant_id" AND r."id" = NEW."refund_id";
  SELECT p."kind", p."unit_id",
         EXISTS (SELECT 1 FROM "finance_payments" x
                  WHERE x."tenant_id" = p."tenant_id" AND x."reverses_id" = p."id") AS reversed
    INTO payment
    FROM "finance_payments" p WHERE p."tenant_id" = NEW."tenant_id" AND p."id" = NEW."payment_id";
  -- A row that is not there (another compound's, say) is the foreign
  -- keys' to refuse.
  IF refund."kind" IS NULL OR payment."kind" IS NULL THEN
    RETURN NEW;
  END IF;
  IF refund."kind" IS DISTINCT FROM 'refund'
     OR payment."kind" IS DISTINCT FROM 'payment'
     OR payment.reversed
     OR payment."unit_id" IS DISTINCT FROM refund."unit_id" THEN
    RAISE EXCEPTION 'finance_refund_sources: a refund takes from a live payment of its unit'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER finance_refund_sources_target
  BEFORE INSERT ON "finance_refund_sources"
  FOR EACH ROW EXECUTE FUNCTION finance_refund_source_targets();

-- ----------------------------------------------------------------------------
-- The bounds, at commit (a backstop: the unit's finance lock keeps writers
-- apart). A refund's sources add up to its amount; a payment's allocations
-- and the sources of its live refunds never exceed its amount.
-- ----------------------------------------------------------------------------
CREATE FUNCTION finance_refund_sources_add_up() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  refund uuid;
  amount numeric;
  taken numeric;
BEGIN
  IF TG_TABLE_NAME = 'finance_refunds' THEN
    IF NEW."kind" <> 'refund' THEN
      RETURN NULL;
    END IF;
    refund := NEW."id";
  ELSE
    refund := NEW."refund_id";
  END IF;
  SELECT r."amount",
         COALESCE((SELECT SUM(s."amount") FROM "finance_refund_sources" s
                    WHERE s."tenant_id" = r."tenant_id" AND s."refund_id" = r."id"), 0)
    INTO amount, taken
    FROM "finance_refunds" r WHERE r."tenant_id" = NEW."tenant_id" AND r."id" = refund;
  IF taken IS DISTINCT FROM amount THEN
    RAISE EXCEPTION 'refund %: its sources (%) do not add up to its amount (%)', refund, taken, amount
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER finance_refunds_sources_add_up
  AFTER INSERT ON "finance_refunds" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance_refund_sources_add_up();
CREATE CONSTRAINT TRIGGER finance_refund_sources_add_up
  AFTER INSERT ON "finance_refund_sources" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance_refund_sources_add_up();

CREATE OR REPLACE FUNCTION finance_payment_within_amount() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  amount numeric;
  taken numeric;
BEGIN
  SELECT p."amount",
         COALESCE((SELECT SUM(a."amount") FROM "finance_allocations" a
                    WHERE a."tenant_id" = p."tenant_id" AND a."payment_id" = p."id"), 0)
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
CREATE CONSTRAINT TRIGGER finance_refund_sources_within_payment
  AFTER INSERT ON "finance_refund_sources" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance_payment_within_amount();

-- A reversal reverses an office payment of the same unit that nothing was
-- refunded from: its money left as a refund already (ADR 0048).
CREATE OR REPLACE FUNCTION finance_reversal_targets_office_payment() RETURNS trigger
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
    IF EXISTS (SELECT 1 FROM "finance_refund_sources" s
                WHERE s."tenant_id" = NEW."tenant_id" AND s."payment_id" = NEW."reverses_id"
                  AND NOT EXISTS (SELECT 1 FROM "finance_refunds" x
                                   WHERE x."tenant_id" = s."tenant_id"
                                     AND x."reverses_id" = s."refund_id")) THEN
      RAISE EXCEPTION 'finance_payments: a payment money was refunded from cannot be reversed'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- Privileges and RLS. Nothing here is updated or deleted.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "finance_refunds", "finance_refund_sources" FROM jiwar_app;
GRANT SELECT, INSERT ON "finance_refunds", "finance_refund_sources" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_refunds', 'finance_refund_sources'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
