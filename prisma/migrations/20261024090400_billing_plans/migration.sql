-- ============================================================================
-- Phase R6a — recurring billing (ADR 0046). A plan bills every unit of the
-- compound a fixed amount each period (monthly, quarterly, annual), with
-- per-unit overrides (another amount, or none at all). A sweep issues each
-- period's invoices, at most one per (plan, unit, period).
-- ============================================================================

CREATE TYPE "billing_frequency" AS ENUM ('monthly', 'quarterly', 'annual');

-- ----------------------------------------------------------------------------
-- Plans: never deleted (invoices point at them); retired with `active`.
-- What they bill and when is fixed at creation; names, amount and days may
-- change and apply to periods issued afterwards.
-- ----------------------------------------------------------------------------
CREATE TABLE "billing_plans" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "kind" "invoice_kind" NOT NULL,
    "frequency" "billing_frequency" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "starts_on" DATE NOT NULL,
    "issue_days_before" INTEGER NOT NULL,
    "due_days_after_issue" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "billing_plans_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "billing_plans_tenant_id_id_key" ON "billing_plans"("tenant_id", "id");
ALTER TABLE "billing_plans"
  ADD CONSTRAINT "billing_plans_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "billing_plans_tenant_id_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "billing_plans" ADD CONSTRAINT "billing_plans_names_length"
  CHECK (char_length("name_en") BETWEEN 1 AND 80 AND char_length("name_ar") BETWEEN 1 AND 80);
ALTER TABLE "billing_plans" ADD CONSTRAINT "billing_plans_amount"
  CHECK ("amount" > 0 AND "amount" <= 1000000);
-- A period starts on the first of a month.
ALTER TABLE "billing_plans" ADD CONSTRAINT "billing_plans_starts_on"
  CHECK (extract(day FROM "starts_on") = 1);
ALTER TABLE "billing_plans" ADD CONSTRAINT "billing_plans_days"
  CHECK ("issue_days_before" BETWEEN 0 AND 28 AND "due_days_after_issue" BETWEEN 0 AND 90);
CREATE FUNCTION billing_plan_keeps_its_terms() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."kind" = OLD."kind"
     AND NEW."frequency" = OLD."frequency"
     AND NEW."starts_on" = OLD."starts_on"
     AND NEW."created_by_account_id" = OLD."created_by_account_id"
     AND NEW."created_at" = OLD."created_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'billing_plans: what a plan bills and when is fixed (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER billing_plans_keep_terms
  BEFORE UPDATE OR DELETE ON "billing_plans"
  FOR EACH ROW EXECUTE FUNCTION billing_plan_keeps_its_terms();
CREATE TRIGGER billing_plans_keep_terms_truncate
  BEFORE TRUNCATE ON "billing_plans"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Overrides: one per plan and unit — another amount, or excluded.
-- Configuration: changed and removed by the staff, audited.
-- ----------------------------------------------------------------------------
CREATE TABLE "billing_plan_overrides" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "amount" DECIMAL(12,2),
    "excluded" BOOLEAN NOT NULL,
    "updated_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "billing_plan_overrides_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "billing_plan_overrides_tenant_id_id_key" ON "billing_plan_overrides"("tenant_id", "id");
CREATE UNIQUE INDEX "billing_plan_overrides_one_per_unit"
  ON "billing_plan_overrides"("tenant_id", "plan_id", "unit_id");
ALTER TABLE "billing_plan_overrides"
  ADD CONSTRAINT "billing_plan_overrides_tenant_id_plan_id_fkey"
  FOREIGN KEY ("tenant_id", "plan_id") REFERENCES "billing_plans"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "billing_plan_overrides_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "billing_plan_overrides_tenant_id_updated_by_fkey"
  FOREIGN KEY ("tenant_id", "updated_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- An amount, or excluded: exactly one.
ALTER TABLE "billing_plan_overrides" ADD CONSTRAINT "billing_plan_overrides_shape"
  CHECK ("excluded" = ("amount" IS NULL));
ALTER TABLE "billing_plan_overrides" ADD CONSTRAINT "billing_plan_overrides_amount"
  CHECK ("amount" IS NULL OR ("amount" > 0 AND "amount" <= 1000000));

-- ----------------------------------------------------------------------------
-- What a plan issued: its batches and invoices name the plan and the period.
-- At most one invoice per (plan, unit, period), whatever runs the sweep.
-- ----------------------------------------------------------------------------
ALTER TABLE "invoice_batches"
  ADD COLUMN "plan_id" UUID,
  ADD COLUMN "period_starts_on" DATE;
ALTER TABLE "invoice_batches" ADD CONSTRAINT "invoice_batches_tenant_id_plan_id_fkey"
  FOREIGN KEY ("tenant_id", "plan_id") REFERENCES "billing_plans"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "invoice_batches" ADD CONSTRAINT "invoice_batches_plan_shape"
  CHECK (("plan_id" IS NULL) = ("period_starts_on" IS NULL));

ALTER TABLE "invoices"
  ADD COLUMN "plan_id" UUID,
  ADD COLUMN "period_starts_on" DATE,
  ADD COLUMN "period_ends_on" DATE;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_plan_id_fkey"
  FOREIGN KEY ("tenant_id", "plan_id") REFERENCES "billing_plans"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE UNIQUE INDEX "invoices_one_per_plan_unit_period"
  ON "invoices"("tenant_id", "plan_id", "unit_id", "period_starts_on")
  WHERE "plan_id" IS NOT NULL;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_plan_shape"
  CHECK (("plan_id" IS NULL) = ("period_starts_on" IS NULL)
     AND ("plan_id" IS NULL) = ("period_ends_on" IS NULL));
-- The period's last day is excluded.
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_period"
  CHECK ("period_starts_on" IS NULL OR "period_ends_on" IS NULL
      OR "period_ends_on" > "period_starts_on");

-- ----------------------------------------------------------------------------
-- Privileges and RLS. A plan is never deleted; an override may be.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "billing_plans", "billing_plan_overrides" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "billing_plans" TO jiwar_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "billing_plan_overrides" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_plans', 'billing_plan_overrides'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
