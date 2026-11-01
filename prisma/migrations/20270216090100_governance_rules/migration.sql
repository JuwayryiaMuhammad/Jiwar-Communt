-- ============================================================================
-- The compound's governance rules (ADR 0075): which candidacies are refused
-- at nomination, checked by the system — an owner whose units owe past
-- their due date, and an owner who also holds an active staff or manager
-- account (the same identity document). Both off by default; the rest of
-- eligibility stays the manager's, by disqualification with a code (ADR
-- 0051). One row per compound, written the first time the manager sets a
-- rule: no row reads as the defaults.
-- ============================================================================

CREATE TABLE "governance_rules" (
    "tenant_id" UUID NOT NULL,
    "candidacy_no_dues" BOOLEAN NOT NULL DEFAULT false,
    "candidacy_not_staff" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_account_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "governance_rules_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "governance_rules"
  ADD CONSTRAINT "governance_rules_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_rules_tenant_id_updated_by_fkey"
  FOREIGN KEY ("tenant_id", "updated_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

REVOKE ALL ON "governance_rules" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "governance_rules" TO jiwar_app;
ALTER TABLE "governance_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "governance_rules" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "governance_rules"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
