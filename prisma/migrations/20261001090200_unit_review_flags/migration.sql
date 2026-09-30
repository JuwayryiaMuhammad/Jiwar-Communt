-- ============================================================================
-- Phase 2.2 — unit review flags (ADR 0021). The single review flag on units
-- becomes one row per reason, so reasons can coexist (a primary who left
-- and a separation) and nothing is lost when one is cleared.
-- Also: the new primary's "to review" list, and wage obligations recorded
-- for payroll whenever a worker's file would close (ADR 0017 update).
-- ============================================================================

CREATE TYPE "unit_review_reason" AS ENUM (
  'primary_left', 'primary_frozen', 'primary_deceased', 'separation');
CREATE TYPE "wage_obligation_kind" AS ENUM ('pay_in_full', 'settle_before_close');
ALTER TYPE "delegation_end_reason" ADD VALUE 'household_ended';

CREATE TABLE "unit_review_flags" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "reason" "unit_review_reason" NOT NULL,
    -- The manager's reason code (death, separation); never free text.
    "reason_code" TEXT,
    -- Free text for managers only: never shown to members, never audited.
    "note" TEXT,
    "flagged_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "flagged_by" UUID,
    "cleared_at" TIMESTAMPTZ(3),
    "cleared_by" UUID,
    "clear_reason_code" TEXT,
    CONSTRAINT "unit_review_flags_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "unit_review_flags_one_open_per_reason"
  ON "unit_review_flags"("unit_id", "reason") WHERE "cleared_at" IS NULL;
CREATE INDEX "unit_review_flags_tenant_id_flagged_at_id_idx"
  ON "unit_review_flags"("tenant_id", "flagged_at" DESC, "id" DESC);
ALTER TABLE "unit_review_flags"
  ADD CONSTRAINT "unit_review_flags_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_review_flags_tenant_id_flagged_by_fkey"
  FOREIGN KEY ("tenant_id", "flagged_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_review_flags_tenant_id_cleared_by_fkey"
  FOREIGN KEY ("tenant_id", "cleared_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- A cleared flag says why; an open one has nothing to say yet.
ALTER TABLE "unit_review_flags" ADD CONSTRAINT "unit_review_flags_clear_is_complete"
  CHECK (("cleared_at" IS NULL AND "clear_reason_code" IS NULL AND "cleared_by" IS NULL)
      OR ("cleared_at" IS NOT NULL AND "clear_reason_code" IS NOT NULL));
-- Death and separation are manager decisions with a reason code.
ALTER TABLE "unit_review_flags" ADD CONSTRAINT "unit_review_flags_manager_reason"
  CHECK ("reason" NOT IN ('primary_deceased', 'separation')
      OR ("reason_code" IS NOT NULL AND "flagged_by" IS NOT NULL));

-- The new primary reviews members whose permissions predate them.
ALTER TABLE "household_members" ADD COLUMN "permissions_reviewed_at" TIMESTAMPTZ(3);

CREATE TABLE "worker_wage_obligations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "engagement_id" UUID NOT NULL,
    "worker_id" UUID NOT NULL,
    "kind" "wage_obligation_kind" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Filled by payroll when it exists.
    "settled_at" TIMESTAMPTZ(3),
    "settled_by" UUID,
    CONSTRAINT "worker_wage_obligations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "worker_wage_obligations_one_open_per_kind"
  ON "worker_wage_obligations"("engagement_id", "kind") WHERE "settled_at" IS NULL;
CREATE INDEX "worker_wage_obligations_tenant_id_worker_id_idx"
  ON "worker_wage_obligations"("tenant_id", "worker_id");
ALTER TABLE "worker_wage_obligations"
  ADD CONSTRAINT "worker_wage_obligations_tenant_id_engagement_id_fkey"
  FOREIGN KEY ("tenant_id", "engagement_id") REFERENCES "worker_engagements"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "worker_wage_obligations_tenant_id_worker_id_fkey"
  FOREIGN KEY ("tenant_id", "worker_id") REFERENCES "domestic_workers"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "worker_wage_obligations_tenant_id_settled_by_fkey"
  FOREIGN KEY ("tenant_id", "settled_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "worker_wage_obligations" ADD CONSTRAINT "worker_wage_obligations_settled_by_needs_time"
  CHECK ("settled_by" IS NULL OR "settled_at" IS NOT NULL);

-- Move today's flags, compound by compound (FORCE RLS applies here too).
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    INSERT INTO "unit_review_flags" ("id", "tenant_id", "unit_id", "reason", "flagged_at")
    SELECT gen_random_uuid(), "tenant_id", "id", 'primary_left',
           COALESCE("household_review_flagged_at", CURRENT_TIMESTAMP)
      FROM "units" WHERE "needs_household_review";
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

-- Dropping the columns drops their two CHECKs with them.
ALTER TABLE "units"
  DROP COLUMN "needs_household_review",
  DROP COLUMN "household_review_reason",
  DROP COLUMN "household_review_flagged_at";

-- Privileges and row-level security (ADR 0005). Never deleted.
REVOKE DELETE ON "unit_review_flags", "worker_wage_obligations" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "unit_review_flags", "worker_wage_obligations" TO jiwar_app;

ALTER TABLE "unit_review_flags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "unit_review_flags" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "unit_review_flags"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "worker_wage_obligations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "worker_wage_obligations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "worker_wage_obligations"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
