-- ============================================================================
-- The board approves a manager leaving without a handover (ADR 0075):
-- `manager_handover_override`, a new approval type naming the manager's
-- account. Dated after 20270406090200 (ADR 0082's compensation_above_limit),
-- which recreates the same CHECKs, so a fresh database and an existing one
-- both end with every type. Every compound gets its settings row. No
-- personal data here.
-- ============================================================================

ALTER TABLE "governance_approval_requests" DROP CONSTRAINT "governance_approval_requests_type";
ALTER TABLE "governance_approval_requests" ADD CONSTRAINT "governance_approval_requests_type"
  CHECK ("type" IN ('annual_budget', 'budget_increase', 'major_contract', 'exceptional_fee',
                    'waiver_above_limit', 'payment_plan_above_limit', 'legal_escalation',
                    'compensation_above_limit', 'manager_handover_override'));
ALTER TABLE "governance_approval_requests" DROP CONSTRAINT "governance_approval_requests_subject";
ALTER TABLE "governance_approval_requests" ADD CONSTRAINT "governance_approval_requests_subject"
  CHECK (("subject_id" IS NOT NULL) = ("type" IN ('annual_budget', 'budget_increase', 'manager_handover_override')));
ALTER TABLE "governance_approval_settings" DROP CONSTRAINT "governance_approval_settings_type";
ALTER TABLE "governance_approval_settings" ADD CONSTRAINT "governance_approval_settings_type"
  CHECK ("type" IN ('annual_budget', 'budget_increase', 'major_contract', 'exceptional_fee',
                    'waiver_above_limit', 'payment_plan_above_limit', 'legal_escalation',
                    'compensation_above_limit', 'manager_handover_override', 'board_appeal', 'objection'));
-- FORCE RLS applies to the migrator too: one compound at a time.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    INSERT INTO "governance_approval_settings" ("tenant_id", "type", "deadline_days")
      VALUES (t."id", 'manager_handover_override', 14)
      ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
