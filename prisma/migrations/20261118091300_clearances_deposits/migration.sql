-- ============================================================================
-- Clearance certificates and deposits (ADR 0062)
-- ============================================================================
--
-- A clearance states that a unit owes the compound nothing as of an
-- instant: issued only when the balance, open disputes included, is zero,
-- under the unit's finance lock; a record that never changes, its PDF drawn
-- on demand. Anyone holding its code checks it on a public page through a
-- global pointer (the code's SHA-256), as a receipt is checked.
--
-- A deposit is money the management holds (finishing works, a move, the
-- maintenance fund): recorded once; what happens to it is append-only
-- events — a refund asked and withdrawn, refunded, deducted (with a code;
-- unpaid dues become an office payment), forfeited. What is held is
-- computed, never stored.

-- A deposit's deduction for unpaid dues is an office payment of its own
-- method, recorded by the manager who settles, with the deposit's number
-- as its reference.
ALTER TABLE "finance_payments" DROP CONSTRAINT "finance_payments_office_shape";
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_office_shape"
  CHECK ("channel" IS NULL OR "channel" <> 'office'
      OR ("method" IN ('cash', 'bank_transfer', 'cheque', 'deposit_offset')
          AND "recorded_by_account_id" IS NOT NULL));
ALTER TABLE "finance_payments" DROP CONSTRAINT "finance_payments_reference_shape";
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_reference_shape"
  CHECK ("method" IS NULL
      OR ("method" IN ('bank_transfer', 'cheque', 'deposit_offset')) = ("reference" IS NOT NULL));

ALTER TABLE "finance_counters" DROP CONSTRAINT "finance_counters_kind";
ALTER TABLE "finance_counters" ADD CONSTRAINT "finance_counters_kind"
  CHECK ("kind" IN ('invoice', 'credit_note', 'receipt', 'instalment_plan', 'refund', 'expense',
                    'clearance', 'deposit'));

CREATE TABLE "finance_clearances" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "unit_id" UUID NOT NULL,
    "occupancy_id" UUID,
    "requested_by" UUID NOT NULL,
    "as_of" TIMESTAMPTZ(3) NOT NULL,
    "valid_until" DATE NOT NULL,
    "verify_code" CHAR(22) NOT NULL,
    "template" TEXT NOT NULL,
    CONSTRAINT "finance_clearances_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_clearances_tenant_id_id_key" ON "finance_clearances"("tenant_id", "id");
CREATE UNIQUE INDEX "finance_clearances_number_key" ON "finance_clearances"("tenant_id", "number");
CREATE UNIQUE INDEX "finance_clearances_verify_code_key" ON "finance_clearances"("verify_code");
CREATE INDEX "finance_clearances_unit_idx" ON "finance_clearances"("tenant_id", "unit_id", "as_of" DESC);
ALTER TABLE "finance_clearances"
  ADD CONSTRAINT "finance_clearances_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_clearances_unit_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_clearances_occupancy_fkey"
  FOREIGN KEY ("tenant_id", "occupancy_id") REFERENCES "unit_occupancies"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_clearances_requested_by_fkey"
  FOREIGN KEY ("tenant_id", "requested_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_clearances" ADD CONSTRAINT "finance_clearances_shape"
  CHECK ("number" >= 1 AND "verify_code" ~ '^[A-Za-z0-9_-]{22}$'
     AND "template" IN ('certificate.v2')
     AND "valid_until" >= ("as_of" AT TIME ZONE 'UTC')::date);
CREATE TRIGGER finance_clearances_immutable
  BEFORE UPDATE OR DELETE ON "finance_clearances"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER finance_clearances_no_truncate
  BEFORE TRUNCATE ON "finance_clearances"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- The public page's pointer: global, the code's SHA-256 and the record.
CREATE TABLE "clearance_links" (
    "code_hash" CHAR(64) NOT NULL,
    "tenant_id" UUID NOT NULL,
    "clearance_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "clearance_links_pkey" PRIMARY KEY ("code_hash")
);
ALTER TABLE "clearance_links"
  ADD CONSTRAINT "clearance_links_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "clearance_links_clearance_fkey"
  FOREIGN KEY ("tenant_id", "clearance_id") REFERENCES "finance_clearances"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "clearance_links" ADD CONSTRAINT "clearance_links_code_hash_hex"
  CHECK ("code_hash" ~ '^[0-9a-f]{64}$');

CREATE TABLE "finance_deposits" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "unit_id" UUID NOT NULL,
    "occupancy_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" NUMERIC(12, 2) NOT NULL,
    "received_on" DATE NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "recorded_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "finance_deposits_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_deposits_tenant_id_id_key" ON "finance_deposits"("tenant_id", "id");
CREATE UNIQUE INDEX "finance_deposits_number_key" ON "finance_deposits"("tenant_id", "number");
CREATE INDEX "finance_deposits_unit_idx" ON "finance_deposits"("tenant_id", "unit_id", "created_at" DESC);
ALTER TABLE "finance_deposits"
  ADD CONSTRAINT "finance_deposits_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_deposits_unit_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_deposits_occupancy_fkey"
  FOREIGN KEY ("tenant_id", "occupancy_id") REFERENCES "unit_occupancies"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_deposits_recorded_by_fkey"
  FOREIGN KEY ("tenant_id", "recorded_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_deposits" ADD CONSTRAINT "finance_deposits_shape"
  CHECK ("number" >= 1 AND "amount" > 0
     AND "kind" IN ('finishing_works', 'move', 'maintenance_fund', 'other')
     AND "method" IN ('cash', 'bank_transfer', 'cheque')
     AND ("reference" IS NULL OR char_length("reference") BETWEEN 1 AND 100));
CREATE TRIGGER finance_deposits_immutable
  BEFORE UPDATE OR DELETE ON "finance_deposits"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER finance_deposits_no_truncate
  BEFORE TRUNCATE ON "finance_deposits"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

CREATE TABLE "finance_deposit_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "deposit_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" NUMERIC(12, 2),
    "reason_code" TEXT,
    "channel" TEXT,
    "payment_id" UUID,
    "by_account" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "finance_deposit_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "finance_deposit_events_deposit_idx"
  ON "finance_deposit_events"("tenant_id", "deposit_id", "at");
ALTER TABLE "finance_deposit_events"
  ADD CONSTRAINT "finance_deposit_events_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_deposit_events_deposit_fkey"
  FOREIGN KEY ("tenant_id", "deposit_id") REFERENCES "finance_deposits"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_deposit_events_payment_fkey"
  FOREIGN KEY ("tenant_id", "payment_id") REFERENCES "finance_payments"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_deposit_events_by_fkey"
  FOREIGN KEY ("tenant_id", "by_account") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- Money moves in refunds, deductions and forfeits only; a deduction and a
-- forfeit carry a code; a refund its channel; a deduction for unpaid dues
-- its payment.
ALTER TABLE "finance_deposit_events" ADD CONSTRAINT "finance_deposit_events_shape"
  CHECK ("kind" IN ('refund_requested', 'refund_withdrawn', 'refunded', 'deducted', 'forfeited')
     AND ("kind" IN ('refunded', 'deducted', 'forfeited')) = ("amount" IS NOT NULL)
     AND ("amount" IS NULL OR "amount" > 0)
     AND ("kind" IN ('deducted', 'forfeited')) = ("reason_code" IS NOT NULL)
     AND ("reason_code" IS NULL
          OR "reason_code" IN ('unpaid_dues', 'damage', 'cleaning', 'works_unfinished', 'other'))
     AND ("kind" = 'refunded') = ("channel" IS NOT NULL)
     AND ("channel" IS NULL OR "channel" IN ('cash', 'bank_transfer'))
     AND ("payment_id" IS NOT NULL) = ("kind" = 'deducted' AND "reason_code" = 'unpaid_dues'));
CREATE TRIGGER finance_deposit_events_immutable
  BEFORE UPDATE OR DELETE ON "finance_deposit_events"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER finance_deposit_events_no_truncate
  BEFORE TRUNCATE ON "finance_deposit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- A deposit is locked FOR UPDATE by every event written for it: UPDATE,
-- which its trigger refuses. Clearances and events are written once. The
-- links are global: no RLS, reached only through GlobalDbService.
REVOKE ALL ON "finance_clearances", "clearance_links", "finance_deposits",
  "finance_deposit_events" FROM jiwar_app;
GRANT SELECT, INSERT ON "finance_clearances", "clearance_links", "finance_deposit_events" TO jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "finance_deposits" TO jiwar_app;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_clearances', 'finance_deposits', 'finance_deposit_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
