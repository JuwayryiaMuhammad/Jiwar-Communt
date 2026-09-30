-- ============================================================================
-- Phase 2.2 — per-member permissions (ADR 0021). What each household
-- member may USE (visitors, bookings, tickets, finance with a cap per
-- operation, unit security). Distinct from delegation, which lets an adult
-- ADMINISTER the household for the primary (ADR 0016).
-- ============================================================================

CREATE TYPE "member_permission" AS ENUM (
  'visitors_invite', 'bookings', 'tickets', 'finance', 'unit_security');
CREATE TYPE "deferred_action_status" AS ENUM (
  'pending', 'approved', 'declined', 'withdrawn');

-- Backs the grants' FK, which carries is_minor so the database itself can
-- refuse finance to a minor (FK checks bypass RLS: composite, ADR 0010).
CREATE UNIQUE INDEX "household_members_tenant_id_id_is_minor_key"
  ON "household_members"("tenant_id", "id", "is_minor");

CREATE TABLE "household_member_grants" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    -- Follows the member (ON UPDATE CASCADE); see the CHECK below.
    "member_is_minor" BOOLEAN NOT NULL,
    "permission" "member_permission" NOT NULL,
    "cap_per_operation" NUMERIC(12, 2),
    -- NULL: granted by the system (defaults at joining).
    "granted_by" UUID,
    "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by" UUID,
    "revoke_reason_code" TEXT,
    -- What the member was told; erasable, never audited.
    "revoke_note" TEXT,
    CONSTRAINT "household_member_grants_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "household_member_grants_one_live"
  ON "household_member_grants"("member_id", "permission") WHERE "revoked_at" IS NULL;
CREATE INDEX "household_member_grants_tenant_id_member_id_idx"
  ON "household_member_grants"("tenant_id", "member_id");
ALTER TABLE "household_member_grants"
  ADD CONSTRAINT "household_member_grants_member_fkey"
  FOREIGN KEY ("tenant_id", "member_id", "member_is_minor")
  REFERENCES "household_members"("tenant_id", "id", "is_minor")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "household_member_grants_tenant_id_granted_by_fkey"
  FOREIGN KEY ("tenant_id", "granted_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "household_member_grants_tenant_id_revoked_by_fkey"
  FOREIGN KEY ("tenant_id", "revoked_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- A minor can never hold finance: not granted, and a member cannot become
-- a minor while a finance grant (live or past) points at them as an adult.
ALTER TABLE "household_member_grants" ADD CONSTRAINT "household_member_grants_no_minor_finance"
  CHECK ("permission" <> 'finance' OR NOT "member_is_minor");
ALTER TABLE "household_member_grants" ADD CONSTRAINT "household_member_grants_finance_has_cap"
  CHECK (("permission" = 'finance') = ("cap_per_operation" IS NOT NULL));
ALTER TABLE "household_member_grants" ADD CONSTRAINT "household_member_grants_cap_positive"
  CHECK ("cap_per_operation" IS NULL OR "cap_per_operation" > 0);
ALTER TABLE "household_member_grants" ADD CONSTRAINT "household_member_grants_revoke_is_complete"
  CHECK (("revoked_at" IS NULL AND "revoked_by" IS NULL AND "revoke_reason_code" IS NULL)
      OR ("revoked_at" IS NOT NULL AND "revoke_reason_code" IS NOT NULL));

CREATE TABLE "household_deferred_actions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "permission" "member_permission" NOT NULL,
    -- The saved input of the interrupted action, for the primary; erasable.
    "payload" JSONB,
    "status" "deferred_action_status" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(3),
    "decided_by" UUID,
    "decision_reason_code" TEXT,
    "decision_note" TEXT,
    CONSTRAINT "household_deferred_actions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "household_deferred_actions_tenant_id_unit_id_idx"
  ON "household_deferred_actions"("tenant_id", "unit_id");
ALTER TABLE "household_deferred_actions"
  ADD CONSTRAINT "household_deferred_actions_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "household_deferred_actions_tenant_id_member_id_fkey"
  FOREIGN KEY ("tenant_id", "member_id") REFERENCES "household_members"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "household_deferred_actions_tenant_id_decided_by_fkey"
  FOREIGN KEY ("tenant_id", "decided_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "household_deferred_actions" ADD CONSTRAINT "household_deferred_actions_decided_matches_status"
  CHECK (("status" = 'pending') = ("decided_at" IS NULL));
ALTER TABLE "household_deferred_actions" ADD CONSTRAINT "household_deferred_actions_decline_has_reason"
  CHECK ("status" <> 'declined' OR "decision_reason_code" IS NOT NULL);

-- Existing adult members get today's defaults (granted by the system).
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    INSERT INTO "household_member_grants"
      ("id", "tenant_id", "member_id", "member_is_minor", "permission")
    SELECT gen_random_uuid(), m."tenant_id", m."id", false, p.permission
      FROM "household_members" m
     CROSS JOIN (VALUES ('visitors_invite'::member_permission),
                        ('bookings'::member_permission),
                        ('tickets'::member_permission)) AS p(permission)
     WHERE m."account_id" IS NOT NULL
       AND m."status" IN ('active', 'pending_approval');
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

REVOKE DELETE ON "household_member_grants", "household_deferred_actions" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "household_member_grants", "household_deferred_actions" TO jiwar_app;

ALTER TABLE "household_member_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "household_member_grants" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "household_member_grants"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "household_deferred_actions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "household_deferred_actions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "household_deferred_actions"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
