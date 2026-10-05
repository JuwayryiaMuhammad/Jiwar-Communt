-- ============================================================================
-- A worker's monthly wage and its payments (ADR 0037).
--
-- The wage is what the household agreed to pay; a payment is the household
-- saying it paid one month. Payments are recorded, not processed: there is
-- no payment gateway. They are append-only like gate_entries (ADR 0028):
-- SELECT and INSERT for jiwar_app, triggers refusing UPDATE, DELETE and
-- TRUNCATE for every role, and no foreign keys (ids only), so a payment
-- outlives whatever it points at.
--
-- Amounts are in the compound's currency (EGP today); there is no currency
-- column until finance adds one.
-- ============================================================================

ALTER TABLE "worker_engagements" ADD COLUMN "monthly_wage" NUMERIC(10,2);
ALTER TABLE "worker_engagements" ADD CONSTRAINT "worker_engagements_monthly_wage_range"
  CHECK ("monthly_wage" IS NULL OR "monthly_wage" BETWEEN 0.01 AND 1000000);

CREATE TABLE "worker_wage_payments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "engagement_id" UUID NOT NULL,
    "worker_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    -- The month paid for: its first day.
    "period" DATE NOT NULL,
    "amount" NUMERIC(10,2) NOT NULL,
    -- A pointer: an erased payer stays a tombstone.
    "paid_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "worker_wage_payments_pkey" PRIMARY KEY ("id")
);
-- One payment per engagement and month: a second one is refused here too.
CREATE UNIQUE INDEX "worker_wage_payments_one_per_period"
  ON "worker_wage_payments"("tenant_id", "engagement_id", "period");
CREATE INDEX "worker_wage_payments_engagement_idx"
  ON "worker_wage_payments"("tenant_id", "engagement_id", "created_at", "id");
ALTER TABLE "worker_wage_payments" ADD CONSTRAINT "worker_wage_payments_period_is_month"
  CHECK (extract(day FROM "period") = 1);
ALTER TABLE "worker_wage_payments" ADD CONSTRAINT "worker_wage_payments_amount_range"
  CHECK ("amount" BETWEEN 0.01 AND 1000000);

CREATE FUNCTION worker_wage_payments_are_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'wage payments are immutable (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER worker_wage_payments_immutable_rows
  BEFORE UPDATE OR DELETE ON "worker_wage_payments"
  FOR EACH ROW EXECUTE FUNCTION worker_wage_payments_are_immutable();
CREATE TRIGGER worker_wage_payments_immutable_truncate
  BEFORE TRUNCATE ON "worker_wage_payments"
  FOR EACH STATEMENT EXECUTE FUNCTION worker_wage_payments_are_immutable();

REVOKE ALL ON "worker_wage_payments" FROM jiwar_app;
GRANT SELECT, INSERT ON "worker_wage_payments" TO jiwar_app;

ALTER TABLE "worker_wage_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "worker_wage_payments" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "worker_wage_payments"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
