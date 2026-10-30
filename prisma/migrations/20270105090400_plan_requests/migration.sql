-- ============================================================================
-- R11c-1a (ADR 0069): a payment plan the resident asks for, and the offer.
--
-- Instalment plans were the staff's alone (ADR 0048). A resident who sees
-- a unit's money now asks for one on an invoice it still owes, saying in
-- how many months; the finance staff accept it — as a plan they set, on
-- the same path as their own (ADR 0048) — or decline it with a reason. One
-- request waits on an invoice at a time. Whether the invoice still owes is
-- read live: a request on an invoice paid, credited or split meanwhile
-- reads as lapsed, whatever paid it.
--
-- The compound says how many months a resident may ask for, and above
-- what an invoice's due-soon notice also offers a plan, once (the offer's
-- invoice notice row, beside 'due_soon').
-- ============================================================================

ALTER TABLE "finance_settings"
  ADD COLUMN "plan_max_months" SMALLINT NOT NULL DEFAULT 6,
  ADD COLUMN "plan_offer_min_amount" DECIMAL(12,2);
ALTER TABLE "finance_settings" ADD CONSTRAINT "finance_settings_plan_max_months"
  CHECK ("plan_max_months" BETWEEN 2 AND 24);
ALTER TABLE "finance_settings" ADD CONSTRAINT "finance_settings_plan_offer_min_amount"
  CHECK ("plan_offer_min_amount" IS NULL OR "plan_offer_min_amount" > 0);

ALTER TABLE "invoice_notices" DROP CONSTRAINT "invoice_notices_kind";
ALTER TABLE "invoice_notices" ADD CONSTRAINT "invoice_notices_kind"
  CHECK ("kind" IN ('issued', 'due_soon', 'overdue', 'plan_offer'));

CREATE TABLE "instalment_plan_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "months" SMALLINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "last_activity_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decline_reason" TEXT,
    "plan_id" UUID,
    CONSTRAINT "instalment_plan_requests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "instalment_plan_requests_tenant_id_id_key"
  ON "instalment_plan_requests"("tenant_id", "id");
-- One request waits on an invoice at a time.
CREATE UNIQUE INDEX "instalment_plan_requests_one_pending"
  ON "instalment_plan_requests"("tenant_id", "invoice_id") WHERE "status" = 'pending';
CREATE INDEX "instalment_plan_requests_requester_idx"
  ON "instalment_plan_requests"("tenant_id", "requested_by", "last_activity_at", "id");
CREATE INDEX "instalment_plan_requests_queue_idx"
  ON "instalment_plan_requests"("tenant_id", "status", "created_at", "id");
ALTER TABLE "instalment_plan_requests"
  ADD CONSTRAINT "instalment_plan_requests_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "instalment_plan_requests_invoice_fkey"
  FOREIGN KEY ("tenant_id", "invoice_id") REFERENCES "invoices"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "instalment_plan_requests_unit_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "instalment_plan_requests_requested_by_fkey"
  FOREIGN KEY ("tenant_id", "requested_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "instalment_plan_requests_decided_by_fkey"
  FOREIGN KEY ("tenant_id", "decided_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "instalment_plan_requests_plan_fkey"
  FOREIGN KEY ("tenant_id", "plan_id") REFERENCES "instalment_plans"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "instalment_plan_requests" ADD CONSTRAINT "instalment_plan_requests_months"
  CHECK ("months" BETWEEN 2 AND 24);
ALTER TABLE "instalment_plan_requests" ADD CONSTRAINT "instalment_plan_requests_decline_reason"
  CHECK ("decline_reason" IS NULL
      OR "decline_reason" IN ('amount_too_small', 'too_many_months', 'payment_history', 'other'));
-- What each status carries: pending nothing; accepted its plan and decider;
-- declined its reason and decider; withdrawn by the requester, its time.
ALTER TABLE "instalment_plan_requests" ADD CONSTRAINT "instalment_plan_requests_state_shape"
  CHECK (CASE "status"
    WHEN 'pending' THEN "decided_at" IS NULL AND "decided_by" IS NULL
                    AND "decline_reason" IS NULL AND "plan_id" IS NULL
    WHEN 'accepted' THEN "decided_at" IS NOT NULL AND "decided_by" IS NOT NULL
                     AND "decline_reason" IS NULL AND "plan_id" IS NOT NULL
    WHEN 'declined' THEN "decided_at" IS NOT NULL AND "decided_by" IS NOT NULL
                     AND "decline_reason" IS NOT NULL AND "plan_id" IS NULL
    WHEN 'withdrawn' THEN "decided_at" IS NOT NULL AND "decided_by" IS NULL
                      AND "decline_reason" IS NULL AND "plan_id" IS NULL
    ELSE false END);

-- A request is decided once; what it asked never changes.
CREATE FUNCTION instalment_plan_request_moves_forward() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'instalment_plan_requests rows are never deleted';
  END IF;
  IF OLD."status" <> 'pending' THEN
    RAISE EXCEPTION 'a decided plan request never changes';
  END IF;
  IF NEW."invoice_id" IS DISTINCT FROM OLD."invoice_id"
     OR NEW."unit_id" IS DISTINCT FROM OLD."unit_id"
     OR NEW."requested_by" IS DISTINCT FROM OLD."requested_by"
     OR NEW."months" IS DISTINCT FROM OLD."months"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'what a plan request asked never changes';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER instalment_plan_requests_move_forward
  BEFORE UPDATE OR DELETE ON "instalment_plan_requests"
  FOR EACH ROW EXECUTE FUNCTION instalment_plan_request_moves_forward();
CREATE TRIGGER instalment_plan_requests_no_truncate
  BEFORE TRUNCATE ON "instalment_plan_requests"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- Grants: decided in place under FOR UPDATE; never deleted.
REVOKE ALL ON "instalment_plan_requests" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "instalment_plan_requests" TO jiwar_app;
ALTER TABLE "instalment_plan_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "instalment_plan_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "instalment_plan_requests"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
