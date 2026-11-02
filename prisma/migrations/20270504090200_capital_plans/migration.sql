-- ============================================================================
-- The capital plan to the board (ADR 0086).
--
-- One plan a year per compound (a unique key on the year): its lines are the
-- replacements and works the compound means to pay for that year, each an
-- asset of the register (once per plan) or the staff's words alone, and an
-- amount. The register's computed plan (ADR 0065: commissioning year plus
-- life, at the replacement cost) seeds a new plan's lines; the staff add
-- and remove lines while it is a draft.
--
-- It goes to the board as a new approval type, `capital_plan`, naming the
-- plan (ADR 0055): submitted at the raise (its total the cost, no line
-- changes meanwhile), approved by the board's motion, and then locked for
-- good; a rejection or a withdrawal gives the draft back. One plan a year,
-- one pending request per subject (governance, under the plan's row lock)
-- and the lock once approved make "one approval per year": a second raise
-- waits for the plan's lock and finds it submitted or approved.
--
-- Triggers keep it so: an approved plan never changes, and lines are
-- written only while their plan is a draft. A line's words are plain data,
-- never in the audit trail or a notification.
-- ============================================================================

-- The new approval type, with a subject: the year's plan, beside every type on
-- main. Later-dated migrations recreate these CHECKs: 20270609090100
-- restores the whole set, and gives every compound the type's setting there
-- (ADR 0089's 20270601090000 recreates the settings' CHECK without it, so no
-- row of the type may exist before then).
ALTER TABLE "governance_approval_requests" DROP CONSTRAINT "governance_approval_requests_type";
ALTER TABLE "governance_approval_requests" ADD CONSTRAINT "governance_approval_requests_type"
  CHECK ("type" IN ('annual_budget', 'budget_increase', 'major_contract', 'exceptional_fee',
                    'waiver_above_limit', 'payment_plan_above_limit', 'legal_escalation',
                    'compensation_above_limit', 'manager_handover_override', 'budget_transfer',
                    'capital_plan'));
ALTER TABLE "governance_approval_requests" DROP CONSTRAINT "governance_approval_requests_subject";
ALTER TABLE "governance_approval_requests" ADD CONSTRAINT "governance_approval_requests_subject"
  CHECK (("subject_id" IS NOT NULL) = ("type" IN ('annual_budget', 'budget_increase', 'manager_handover_override',
                                                'budget_transfer', 'capital_plan')));
ALTER TABLE "governance_approval_settings" DROP CONSTRAINT "governance_approval_settings_type";
ALTER TABLE "governance_approval_settings" ADD CONSTRAINT "governance_approval_settings_type"
  CHECK ("type" IN ('annual_budget', 'budget_increase', 'major_contract', 'exceptional_fee',
                    'waiver_above_limit', 'payment_plan_above_limit', 'legal_escalation',
                    'compensation_above_limit', 'manager_handover_override', 'budget_transfer',
                    'capital_plan', 'board_appeal', 'objection'));

-- ----------------------------------------------------------------------------
-- The plans: one a year.
-- ----------------------------------------------------------------------------
CREATE TABLE "capital_plans" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "year" SMALLINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "approval_request_id" UUID,
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "submitted_at" TIMESTAMPTZ(3),
    "approved_at" TIMESTAMPTZ(3),
    CONSTRAINT "capital_plans_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "capital_plans_tenant_id_id_key" ON "capital_plans"("tenant_id", "id");
CREATE UNIQUE INDEX "capital_plans_year_key" ON "capital_plans"("tenant_id", "year");
ALTER TABLE "capital_plans" ADD CONSTRAINT "capital_plans_tenant_id_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- Deferred: the plan is submitted (in governance's raise) before its
-- request row is written, in the same transaction (as a budget, ADR 0055).
ALTER TABLE "capital_plans" ADD CONSTRAINT "capital_plans_tenant_id_request_fkey"
  FOREIGN KEY ("tenant_id", "approval_request_id") REFERENCES "governance_approval_requests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;
-- A draft names no request (a rejected or withdrawn one is history in the
-- audit trail); a submitted plan names the pending one, an approved plan
-- the one that approved it, and when.
ALTER TABLE "capital_plans" ADD CONSTRAINT "capital_plans_shape"
  CHECK ("year" BETWEEN 2000 AND 2100
     AND "status" IN ('draft', 'submitted', 'approved')
     AND (("status" = 'draft') = ("approval_request_id" IS NULL))
     AND (("status" = 'draft') = ("submitted_at" IS NULL))
     AND (("status" = 'approved') = ("approved_at" IS NOT NULL)));

-- Locked once approved: nothing of an approved plan changes again.
CREATE FUNCTION "capital_plans_locked"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'approved'
     OR NEW."year" <> OLD."year"
     OR NEW."created_by_account_id" <> OLD."created_by_account_id"
     OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'an approved capital plan is locked' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "capital_plans_locked" BEFORE UPDATE ON "capital_plans"
  FOR EACH ROW EXECUTE FUNCTION "capital_plans_locked"();

REVOKE ALL ON "capital_plans" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "capital_plans" TO jiwar_app;
ALTER TABLE "capital_plans" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "capital_plans" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "capital_plans"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ----------------------------------------------------------------------------
-- A plan's lines: written only while it is a draft.
-- ----------------------------------------------------------------------------
CREATE TABLE "capital_plan_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "asset_id" UUID,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "capital_plan_lines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "capital_plan_lines_tenant_id_id_key" ON "capital_plan_lines"("tenant_id", "id");
-- An asset is in a plan once.
CREATE UNIQUE INDEX "capital_plan_lines_asset_once"
  ON "capital_plan_lines"("tenant_id", "plan_id", "asset_id") WHERE "asset_id" IS NOT NULL;
CREATE INDEX "capital_plan_lines_plan_idx" ON "capital_plan_lines"("tenant_id", "plan_id", "created_at", "id");
ALTER TABLE "capital_plan_lines" ADD CONSTRAINT "capital_plan_lines_tenant_id_plan_id_fkey"
  FOREIGN KEY ("tenant_id", "plan_id") REFERENCES "capital_plans"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "capital_plan_lines" ADD CONSTRAINT "capital_plan_lines_tenant_id_asset_id_fkey"
  FOREIGN KEY ("tenant_id", "asset_id") REFERENCES "assets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "capital_plan_lines" ADD CONSTRAINT "capital_plan_lines_shape"
  CHECK (char_length("description") BETWEEN 1 AND 200
     AND "amount" > 0
     AND "source" IN ('computed', 'manual'));
-- A computed line is the register's replacement of an asset.
ALTER TABLE "capital_plan_lines" ADD CONSTRAINT "capital_plan_lines_computed_asset"
  CHECK ("source" <> 'computed' OR "asset_id" IS NOT NULL);

-- Lines are added and removed only while their plan is a draft, never edited.
CREATE FUNCTION "capital_plan_lines_draft_only"() RETURNS trigger AS $$
DECLARE
  plan_status TEXT;
  line_tenant UUID;
  line_plan UUID;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'a capital plan line is never edited' USING ERRCODE = 'insufficient_privilege';
  ELSIF TG_OP = 'DELETE' THEN
    line_tenant := OLD."tenant_id";
    line_plan := OLD."plan_id";
  ELSE
    line_tenant := NEW."tenant_id";
    line_plan := NEW."plan_id";
  END IF;
  SELECT "status" INTO plan_status FROM "capital_plans"
   WHERE "tenant_id" = line_tenant AND "id" = line_plan;
  -- A plan it cannot see is left to the foreign key and RLS to refuse.
  IF plan_status IS NOT NULL AND plan_status <> 'draft' THEN
    RAISE EXCEPTION 'only a draft capital plan''s lines change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "capital_plan_lines_draft_only" BEFORE INSERT OR UPDATE OR DELETE ON "capital_plan_lines"
  FOR EACH ROW EXECUTE FUNCTION "capital_plan_lines_draft_only"();

REVOKE ALL ON "capital_plan_lines" FROM jiwar_app;
GRANT SELECT, INSERT, DELETE ON "capital_plan_lines" TO jiwar_app;
ALTER TABLE "capital_plan_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "capital_plan_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "capital_plan_lines"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
