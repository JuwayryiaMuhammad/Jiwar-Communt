-- ============================================================================
-- A compensation above the manager's limit (ADR 0082): the board's, through
-- ADR 0055's approval requests and ADR 0073's binding authority, not a path of
-- its own. A new approval type, `compensation_above_limit`, with a threshold
-- that binds by default: above it, finance refuses the compensation's credit
-- unless it names what an approved request of the type granted, used once by
-- that one compensation. Every compound gets its settings row (no threshold:
-- nothing is above it until the compound sets one).
--
-- The staff inbox's three new types are in 20270518090600, dated after every
-- migration of main that recreates the inbox's CHECKs. No personal data here.
-- ============================================================================

ALTER TABLE "governance_approval_requests" DROP CONSTRAINT "governance_approval_requests_type";
ALTER TABLE "governance_approval_requests" ADD CONSTRAINT "governance_approval_requests_type"
  CHECK ("type" IN ('annual_budget', 'budget_increase', 'major_contract', 'exceptional_fee',
                    'waiver_above_limit', 'payment_plan_above_limit', 'legal_escalation',
                    'compensation_above_limit'));

ALTER TABLE "governance_approval_settings" DROP CONSTRAINT "governance_approval_settings_type";
ALTER TABLE "governance_approval_settings" ADD CONSTRAINT "governance_approval_settings_type"
  CHECK ("type" IN ('annual_budget', 'budget_increase', 'major_contract', 'exceptional_fee',
                    'waiver_above_limit', 'payment_plan_above_limit', 'legal_escalation',
                    'compensation_above_limit', 'board_appeal', 'objection'));
ALTER TABLE "governance_approval_settings" DROP CONSTRAINT "governance_approval_settings_threshold";
ALTER TABLE "governance_approval_settings" ADD CONSTRAINT "governance_approval_settings_threshold"
  CHECK ("threshold" IS NULL
      OR ("type" IN ('major_contract', 'exceptional_fee', 'waiver_above_limit', 'payment_plan_above_limit', 'compensation_above_limit')
          AND "threshold" > 0 AND "threshold" <= 999999999.99));
ALTER TABLE "governance_approval_settings" DROP CONSTRAINT "governance_approval_settings_binding";
ALTER TABLE "governance_approval_settings" ADD CONSTRAINT "governance_approval_settings_binding"
  CHECK (CASE "type"
           WHEN 'major_contract' THEN "binding"
           WHEN 'waiver_above_limit' THEN true
           WHEN 'payment_plan_above_limit' THEN true
           WHEN 'compensation_above_limit' THEN true
           ELSE NOT "binding"
         END);
-- FORCE RLS applies to the migrator too: one compound at a time.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    INSERT INTO "governance_approval_settings" ("tenant_id", "type", "deadline_days", "binding")
      VALUES (t."id", 'compensation_above_limit', 14, true)
      ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

ALTER TABLE "finance_board_authorizations" DROP CONSTRAINT "finance_board_authorizations_type";
ALTER TABLE "finance_board_authorizations" ADD CONSTRAINT "finance_board_authorizations_type"
  CHECK ("type" IN ('waiver_above_limit', 'payment_plan_above_limit', 'compensation_above_limit'));
-- Unused, or used by exactly one dispute's credit (a waiver), one plan
-- request or invoice (a payment plan), or one compensation's credit.
ALTER TABLE "finance_board_authorizations" DROP CONSTRAINT "finance_board_authorizations_used_shape";
ALTER TABLE "finance_board_authorizations" ADD CONSTRAINT "finance_board_authorizations_used_shape"
  CHECK (("used_at" IS NULL AND "used_by_type" IS NULL AND "used_by_id" IS NULL
          AND "used_by_account_id" IS NULL)
      OR ("used_at" IS NOT NULL AND "used_by_id" IS NOT NULL AND "used_by_account_id" IS NOT NULL
          AND "used_by_type" IS NOT NULL
          AND (("type" = 'waiver_above_limit' AND "used_by_type" = 'invoice_dispute')
            OR ("type" = 'payment_plan_above_limit' AND "used_by_type" IN ('plan_request', 'invoice'))
            OR ("type" = 'compensation_above_limit' AND "used_by_type" = 'experience_compensation'))));
