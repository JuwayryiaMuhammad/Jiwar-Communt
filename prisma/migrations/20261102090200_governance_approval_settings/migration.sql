-- ============================================================================
-- Board matters (ADR 0055): a compound's deadlines and thresholds, one row
-- per approval type and one for appeals to the board, created with the
-- compound and backfilled below. Managed with `governance.manage`.
--
-- `deadline_days`: how long the board has to decide a matter raised now
--   (a request's or an appeal's `deadline_at`, fixed when it is raised);
--   past it, the overdue notice, and a member may close a motion with a
--   quorum.
-- `threshold`: for the four thresholded types only. `major_contract`'s is
--   the manager's limit for one expense; the others are shown when a
--   request is raised.
-- ============================================================================

CREATE TABLE "governance_approval_settings" (
    "tenant_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "deadline_days" SMALLINT NOT NULL,
    "threshold" DECIMAL(14,2),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "governance_approval_settings_pkey" PRIMARY KEY ("tenant_id", "type")
);
ALTER TABLE "governance_approval_settings" ADD CONSTRAINT "governance_approval_settings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- APPROVAL_TYPES and `board_appeal`; a unit test keeps them in step.
ALTER TABLE "governance_approval_settings" ADD CONSTRAINT "governance_approval_settings_type"
  CHECK ("type" IN ('annual_budget', 'budget_increase', 'major_contract', 'exceptional_fee',
                    'waiver_above_limit', 'payment_plan_above_limit', 'legal_escalation', 'board_appeal'));
ALTER TABLE "governance_approval_settings" ADD CONSTRAINT "governance_approval_settings_deadline"
  CHECK ("deadline_days" BETWEEN 1 AND 90);
-- THRESHOLD_TYPES; a unit test keeps them in step.
ALTER TABLE "governance_approval_settings" ADD CONSTRAINT "governance_approval_settings_threshold"
  CHECK ("threshold" IS NULL
      OR ("type" IN ('major_contract', 'exceptional_fee', 'waiver_above_limit', 'payment_plan_above_limit')
          AND "threshold" > 0 AND "threshold" <= 999999999.99));

-- One row per type, never deleted.
CREATE TRIGGER governance_approval_settings_kept
  BEFORE DELETE ON "governance_approval_settings"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER governance_approval_settings_kept_truncate
  BEFORE TRUNCATE ON "governance_approval_settings"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "governance_approval_settings" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "governance_approval_settings" TO jiwar_app;
ALTER TABLE "governance_approval_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "governance_approval_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "governance_approval_settings"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ----------------------------------------------------------------------------
-- Existing compounds get what a new one gets (src/governance/provisioning.ts):
-- the eight rows, with the defaults (approval-rules.ts). FORCE RLS applies
-- here too: one compound at a time.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    INSERT INTO "governance_approval_settings" ("tenant_id", "type", "deadline_days")
      VALUES (t."id", 'annual_budget', 30),
             (t."id", 'budget_increase', 14),
             (t."id", 'major_contract', 14),
             (t."id", 'exceptional_fee', 14),
             (t."id", 'waiver_above_limit', 14),
             (t."id", 'payment_plan_above_limit', 14),
             (t."id", 'legal_escalation', 14),
             (t."id", 'board_appeal', 30);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
