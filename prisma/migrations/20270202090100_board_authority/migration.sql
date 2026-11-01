-- ============================================================================
-- The board's authority, binding (ADR 0073). ADR 0055's thresholds for a
-- waiver and a payment plan were shown with a request and enforced nothing.
-- A compound may now make each binding: above it, finance refuses the
-- credit or the plan unless it names what the board approved for it. An
-- approved request of the type grants one authorization of its cost, used
-- once, by one dispute's credit or one plan.
--
-- `major_contract` was binding from the start (the manager's limit for one
-- expense, ADR 0055): its rows say so. `exceptional_fee` stays advisory: no
-- domain charges one yet. No personal data here.
-- ============================================================================

ALTER TABLE "governance_approval_settings"
  ADD COLUMN "binding" BOOLEAN NOT NULL DEFAULT false;
-- Each compound's major_contract row, under its own tenant (FORCE RLS).
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    UPDATE "governance_approval_settings" SET "binding" = true
     WHERE "tenant_id" = t AND "type" = 'major_contract';
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
ALTER TABLE "governance_approval_settings" ADD CONSTRAINT "governance_approval_settings_binding"
  CHECK (CASE "type"
           WHEN 'major_contract' THEN "binding"
           WHEN 'waiver_above_limit' THEN true
           WHEN 'payment_plan_above_limit' THEN true
           ELSE NOT "binding"
         END);

-- ----------------------------------------------------------------------------
-- What an approved waiver or payment plan request lets finance do once: a
-- dispute's credit, or a plan, up to `amount`. `used_*` is set once, by the
-- one it served; the terms never change; nothing is deleted.
-- ----------------------------------------------------------------------------
CREATE TABLE "finance_board_authorizations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "approval_request_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "used_by_type" TEXT,
    "used_by_id" UUID,
    "used_by_account_id" UUID,
    CONSTRAINT "finance_board_authorizations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finance_board_authorizations_tenant_id_id_key"
  ON "finance_board_authorizations"("tenant_id", "id");
CREATE UNIQUE INDEX "finance_board_authorizations_request_key"
  ON "finance_board_authorizations"("tenant_id", "approval_request_id");
CREATE INDEX "finance_board_authorizations_unused_idx"
  ON "finance_board_authorizations"("tenant_id", "type", "created_at")
  WHERE "used_at" IS NULL;
ALTER TABLE "finance_board_authorizations"
  ADD CONSTRAINT "finance_board_authorizations_tenant_id_request_id_fkey"
  FOREIGN KEY ("tenant_id", "approval_request_id") REFERENCES "governance_approval_requests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_board_authorizations"
  ADD CONSTRAINT "finance_board_authorizations_tenant_id_used_by_account_id_fkey"
  FOREIGN KEY ("tenant_id", "used_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_board_authorizations" ADD CONSTRAINT "finance_board_authorizations_type"
  CHECK ("type" IN ('waiver_above_limit', 'payment_plan_above_limit'));
ALTER TABLE "finance_board_authorizations" ADD CONSTRAINT "finance_board_authorizations_amount"
  CHECK ("amount" > 0 AND "amount" <= 999999999.99);
-- Unused, or used by exactly one dispute's credit (a waiver) or one plan
-- request or invoice (a payment plan), by someone, at a time.
ALTER TABLE "finance_board_authorizations" ADD CONSTRAINT "finance_board_authorizations_used_shape"
  CHECK (("used_at" IS NULL AND "used_by_type" IS NULL AND "used_by_id" IS NULL
          AND "used_by_account_id" IS NULL)
      OR ("used_at" IS NOT NULL AND "used_by_id" IS NOT NULL AND "used_by_account_id" IS NOT NULL
          AND "used_by_type" IS NOT NULL
          AND (("type" = 'waiver_above_limit' AND "used_by_type" = 'invoice_dispute')
            OR ("type" = 'payment_plan_above_limit' AND "used_by_type" IN ('plan_request', 'invoice')))));

CREATE FUNCTION finance_board_authorizations_used_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."approval_request_id" IS DISTINCT FROM OLD."approval_request_id"
     OR NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."amount" IS DISTINCT FROM OLD."amount"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'finance_board_authorizations: the terms are fixed';
  END IF;
  IF OLD."used_at" IS NOT NULL THEN
    RAISE EXCEPTION 'finance_board_authorizations: used once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER finance_board_authorizations_used_once
  BEFORE UPDATE ON "finance_board_authorizations"
  FOR EACH ROW EXECUTE FUNCTION finance_board_authorizations_used_once();
CREATE TRIGGER finance_board_authorizations_no_delete
  BEFORE DELETE ON "finance_board_authorizations"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER finance_board_authorizations_no_truncate
  BEFORE TRUNCATE ON "finance_board_authorizations"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Grants and RLS. Written once, used once under FOR UPDATE; never deleted.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "finance_board_authorizations" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "finance_board_authorizations" TO jiwar_app;
ALTER TABLE "finance_board_authorizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "finance_board_authorizations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "finance_board_authorizations"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
